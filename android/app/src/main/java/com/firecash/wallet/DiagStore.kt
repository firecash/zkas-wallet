package com.firecash.wallet

import android.content.Context
import android.content.pm.ApplicationInfo
import android.os.Build
import android.os.Process
import android.os.SystemClock
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.SecureRandom
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

/**
 * The Android half of the diagnostic log: a rotating JSONL store in `<files>/diag/`
 * (10 files x 2 MB), shared by the WebView (already-redacted batches through the
 * Diagnostics plugin) and the native collectors (lifecycle, process exits, jank, memory,
 * battery, thermal, crashes).
 *
 * Writes go to one background thread; nothing here touches the disk on the main thread
 * except a crash's last record, which must land before the process dies.
 *
 * Local only. Files leave the device only through the plugin's `export`, which hands one
 * file to the system share sheet when the user asks.
 */
object DiagStore {
    private const val FILES = 10
    private const val FILE_BYTES = 2L * 1024 * 1024
    private const val MAX_LINE = 16 * 1024
    private const val PREFS = "zkas_diag"
    const val TAG = "ZKasDiag"

    const val OFF = 0
    const val NORMAL = 1
    const val VERBOSE = 2

    @Volatile private var dir: File? = null
    @Volatile var level: Int = NORMAL
        private set
    @Volatile private var debuggable = false
    private val seq = AtomicLong(0)
    private val writer = Executors.newSingleThreadExecutor { r -> Thread(r, "diag-writer").apply { isDaemon = true } }
    private val lock = Any()
    lateinit var sid: String
        private set
    @Volatile var listener: ((String) -> Unit)? = null

    /** When this process started, on the elapsedRealtime clock. */
    val processStart: Long by lazy {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) Process.getStartElapsedRealtime() else SystemClock.elapsedRealtime()
    }

    // Not ThreadLocal.withInitial: that is API 26, and minSdk is 23.
    private val iso = object : ThreadLocal<SimpleDateFormat>() {
        override fun initialValue(): SimpleDateFormat =
            SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
    }

    private fun hex(bytes: Int): String {
        val b = ByteArray(bytes)
        SecureRandom().nextBytes(b)
        return b.joinToString("") { String.format("%02x", it.toInt() and 0xff) }
    }

    @JvmStatic
    @Synchronized
    fun init(ctx: Context) {
        if (dir != null) return
        val d = File(ctx.filesDir, "diag")
        d.mkdirs()
        val saltFile = File(d, "salt")
        val salt = saltFile.takeIf { it.exists() }?.readText()?.trim()?.takeIf { it.length == 32 } ?: hex(16).also { saltFile.writeText(it) }
        DiagRedact.salt = salt
        level = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getInt("level", NORMAL)
        debuggable = (ctx.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        sid = hex(6)
        dir = d
    }

    fun salt(): String = DiagRedact.salt

    fun setLevel(ctx: Context, name: String) {
        level = when (name) { "off" -> OFF; "verbose" -> VERBOSE; else -> NORMAL }
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putInt("level", level).apply()
    }

    fun levelName(): String = when (level) { OFF -> "off"; VERBOSE -> "verbose"; else -> "normal" }

    private fun file(i: Int): File = File(dir, "diag.$i.jsonl")

    private fun writeLines(lines: List<String>) {
        val d = dir ?: return
        synchronized(lock) {
            val current = File(d, "diag.0.jsonl")
            if (current.exists() && current.length() >= FILE_BYTES) {
                file(FILES - 1).delete()
                for (i in FILES - 2 downTo 0) file(i).renameTo(file(i + 1))
            }
            try {
                FileOutputStream(current, true).use { out ->
                    val sb = StringBuilder()
                    for (l in lines) sb.append(l).append('\n')
                    out.write(sb.toString().toByteArray(Charsets.UTF_8))
                }
            } catch (_: Throwable) {
                // A log that cannot be written must never take the app down.
            }
        }
    }

    private fun envelope(cat: String, ev: String, lvl: String, fields: Map<String, Any?>): String {
        val o = JSONObject()
        o.put("t", iso.get()!!.format(Date()))
        o.put("m", SystemClock.elapsedRealtime() - processStart)
        o.put("src", "android")
        o.put("sid", sid)
        o.put("seq", seq.incrementAndGet())
        o.put("lvl", lvl)
        o.put("cat", cat)
        o.put("ev", ev)
        for ((k, v) in fields) if (v != null && !o.has(k)) o.put(k, v)
        // Fields are numbers, enums and fixed strings by construction; the whole line is
        // scrubbed anyway, so a careless one cannot leak.
        return DiagRedact.scrub(o.toString(), Int.MAX_VALUE)
    }

    /** Record one native event. Never blocks the caller on the disk. */
    @JvmStatic
    @JvmOverloads
    fun emit(cat: String, ev: String, lvl: String = "info", fields: Map<String, Any?> = emptyMap(), verbose: Boolean = false) {
        if (dir == null || level == OFF) return
        if (verbose && level != VERBOSE) return
        val line = try { envelope(cat, ev, lvl, fields) } catch (_: Throwable) { return }
        if (debuggable) Log.d(TAG, line)
        listener?.let { l -> try { l(line) } catch (_: Throwable) {} }
        writer.execute { writeLines(listOf(line)) }
    }

    /** A crash: written on the calling thread, because the process is about to die. */
    fun emitSync(cat: String, ev: String, lvl: String, fields: Map<String, Any?>) {
        if (dir == null || level == OFF) return
        val line = try { envelope(cat, ev, lvl, fields) } catch (_: Throwable) { return }
        if (debuggable) Log.e(TAG, line)
        writeLines(listOf(line))
    }

    /** A batch from the WebView: each line must be one JSON object; scrubbed again here. */
    fun append(lines: List<String>) {
        if (dir == null || level == OFF) return
        val ok = lines.filter { it.length <= MAX_LINE && it.startsWith("{") && runCatching { JSONObject(it) }.isSuccess }
            .map { DiagRedact.scrub(it, Int.MAX_VALUE) }
        if (ok.isEmpty()) return
        if (debuggable && level == VERBOSE) for (l in ok) Log.v(TAG, l)
        writer.execute { writeLines(ok) }
    }

    fun clear() {
        synchronized(lock) { for (i in 0 until FILES) file(i).delete() }
    }

    fun stats(): Pair<Int, Long> {
        var n = 0
        var bytes = 0L
        for (i in 0 until FILES) {
            val f = file(i)
            if (f.exists()) { n++; bytes += f.length() }
        }
        return n to bytes
    }

    /** One export file in the cache dir: the header, then every file oldest first. */
    fun buildExport(ctx: Context, header: String): File {
        val outDir = File(ctx.cacheDir, "diag-export")
        outDir.mkdirs()
        // Only the newest export is kept; an older one is just a stale copy.
        outDir.listFiles()?.forEach { it.delete() }
        val stamp = SimpleDateFormat("yyyy-MM-dd'T'HH-mm-ss", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date())
        val out = File(outDir, "zkas-diagnostics-$stamp.jsonl")
        val safeHeader = if (runCatching { JSONObject(header) }.isSuccess) DiagRedact.scrub(header, Int.MAX_VALUE) else "{}"
        synchronized(lock) {
            FileOutputStream(out).use { o ->
                o.write((safeHeader + "\n").toByteArray(Charsets.UTF_8))
                var dropped = 0
                for (i in FILES - 1 downTo 0) {
                    val f = file(i)
                    if (f.exists()) f.bufferedReader(Charsets.UTF_8).useLines { lines ->
                        for (line in lines) {
                            val clean = exportLine(line)
                            if (clean == null) { if (line.isNotEmpty()) dropped++; continue }
                            o.write((clean + "\n").toByteArray(Charsets.UTF_8))
                        }
                    }
                }
                if (dropped > 0) o.write("{\"src\":\"android\",\"cat\":\"diag\",\"ev\":\"export_dropped\",\"lines\":$dropped}\n".toByteArray(Charsets.UTF_8))
            }
        }
        return out
    }

    /**
     * One stored line as it goes into an export, or null to leave it out.
     *
     * A power cut, a kernel panic or a crashed emulator loses what the page cache had not
     * written yet, and the file system fills that span with NUL bytes: the first real
     * on-device run (2026-10-22, the emulator's host process segfaulting) exported two
     * lines that were 1-2 KB of NULs, one of them followed by a perfectly good event. The
     * NULs are dropped and the event kept; a line torn mid-object is left out (and counted).
     */
    @JvmStatic
    fun exportLine(line: String): String? {
        val s = if (line.indexOf('\u0000') >= 0) line.replace("\u0000", "") else line
        val t = s.trim()
        return if (t.length >= 2 && t[0] == '{' && t[t.length - 1] == '}') t else null
    }
}
