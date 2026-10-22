package com.firecash.wallet

import java.security.MessageDigest
import java.util.regex.Matcher
import java.util.regex.Pattern

/**
 * The free-text rules of the diagnostic log's redactor, ported from `src/diag/redact.ts`
 * (the canonical implementation) for the few strings Android writes itself: crash
 * messages and stacks, process-exit descriptions, ANR trace heads — and, as a second line
 * of defence, every line the WebView appends.
 *
 * Held to the same `test/diag-redaction-vectors.json` as the JavaScript and Rust versions
 * (DiagRedactTest), so the three cannot drift apart silently. Pure JVM: no Android API.
 */
object DiagRedact {
    private val PUBLIC_HOSTS = setOf(
        "seed.zkas.info", "wallet.zkas.info", "zkas.info", "explorer.zkas.info", "services.zkas.info", "api.zkas.info",
        "185.147.157.125", "160.187.211.153", "142.248.80.23", "127.0.0.1", "localhost",
        "plqu6zzg5u6lkofv76m3pnnxzbaus6pgs4thced4wejdroi7z7exd6qd.onion",
    )

    private val PHRASE = Pattern.compile("\\b(?:[a-z]{3,8}[ \\t]+){11,}[a-z]{3,8}\\b")
    private val ADDRESS = Pattern.compile("\\b(?:zkas|zkastest|zkasdev|zkassim|firecash|kaspa|kaspatest|kaspadev|kaspasim):[a-z0-9]{20,}", Pattern.CASE_INSENSITIVE)
    private val ONION = Pattern.compile("\\b[a-z2-7]{16,56}\\.onion\\b", Pattern.CASE_INSENSITIVE)
    private val EMAIL = Pattern.compile("[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+")
    private val HEX64 = Pattern.compile("\\b[0-9a-fA-F]{64}\\b")
    private val HEX = Pattern.compile("[0-9a-fA-F]{16,}")
    private val TOKEN = Pattern.compile("[A-Za-z0-9+_=-]{32,}")
    private val IPV4 = Pattern.compile("\\b(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\b")
    private val MONEY = Pattern.compile("(^|[^~\\w.<>=-])(-?\\d[\\d,_]*(?:\\.\\d+)?)\\s*(ZKAS|KAS|sompi|FC)\\b", Pattern.CASE_INSENSITIVE)
    private val FAST = Pattern.compile("[\\d:@]")
    private val HEXLETTERS = Pattern.compile("[a-fA-F]{16}")
    private val DIGIT = Pattern.compile("\\d")
    private val HEXLETTER = Pattern.compile("[a-fA-F]")
    private val LETTER = Pattern.compile("[A-Za-z]")

    @Volatile var salt: String = ""
    @Volatile var known: List<String> = emptyList()

    fun pseudonym(salt: String, kind: String, value: String): String {
        val md = MessageDigest.getInstance("SHA-256")
        val bytes = md.digest("$salt:$kind:${value.trim().lowercase()}".toByteArray(Charsets.UTF_8))
        val sb = StringBuilder()
        for (i in 0 until 4) sb.append(String.format("%02x", bytes[i].toInt() and 0xff))
        return sb.toString()
    }

    fun bucketAmount(zkas: Double): String {
        if (zkas.isNaN() || zkas.isInfinite()) return "?"
        val v = Math.abs(zkas)
        val sign = if (zkas < 0) "-" else ""
        if (v == 0.0) return "0"
        val decades = listOf(
            0.001 to "<0.001", 0.01 to "0.001-0.01", 0.1 to "0.01-0.1", 1.0 to "0.1-1", 10.0 to "1-10",
            100.0 to "10-100", 1_000.0 to "100-1k", 10_000.0 to "1k-10k", 100_000.0 to "10k-100k", 1_000_000.0 to "100k-1M",
        )
        for ((limit, name) in decades) if (v < limit) return sign + name
        return "$sign>=1M"
    }

    private inline fun replace(p: Pattern, s: String, f: (Matcher) -> String): String {
        val m = p.matcher(s)
        val out = StringBuffer()
        while (m.find()) m.appendReplacement(out, Matcher.quoteReplacement(f(m)))
        m.appendTail(out)
        return out.toString()
    }

    /// Product tokens of a user agent: a dotted four-part number right after one of these is
    /// a browser/WebView version, not an address. Same list and rule as UA_PRODUCTS in
    /// src/diag/redact.ts, pinned by the shared vectors.
    private val UA_PRODUCTS = listOf(
        "Chrome", "Chromium", "CriOS", "Edg", "EdgA", "EdgiOS", "Edge", "Firefox", "FxiOS", "OPR", "Opera",
        "Version", "Safari", "AppleWebKit", "SamsungBrowser", "YaBrowser", "Electron", "Gecko", "Mobile",
    )

    private fun afterUaProduct(before: String): Boolean = UA_PRODUCTS.any { before.endsWith("$it/") }

    private fun privateIpv4(a: Int, b: Int): Boolean =
        a == 10 || a == 127 || (a == 192 && b == 168) || (a == 172 && b in 16..31) || (a == 169 && b == 254)

    /** Mirrors `redactText` in src/diag/redact.ts. */
    fun scrub(input: String, max: Int = 300, saltOverride: String? = null, knownOverride: List<String>? = null): String {
        val salt = saltOverride ?: this.salt
        var s = input
        for (k in knownOverride ?: known) if (k.length >= 8 && s.contains(k)) s = s.replace(k, "x:" + pseudonym(salt, "secret", k))
        if (s.length < 47 && !FAST.matcher(s).find() && !HEXLETTERS.matcher(s).find() && !s.contains(".onion")) return s
        s = PHRASE.matcher(s).replaceAll("[phrase]")
        s = replace(ADDRESS, s) { "addr:" + pseudonym(salt, "addr", it.group()) }
        s = replace(ONION, s) { if (PUBLIC_HOSTS.contains(it.group().lowercase())) it.group() else "onion:" + pseudonym(salt, "host", it.group()) }
        s = EMAIL.matcher(s).replaceAll("[email]")
        // A hex run counts only with a letter in it: digits alone are a number.
        s = replace(HEX64, s) { if (HEXLETTER.matcher(it.group()).find()) "h:" + pseudonym(salt, "hash", it.group()) else it.group() }
        s = replace(HEX, s) { if (HEXLETTER.matcher(it.group()).find()) "x:" + pseudonym(salt, "hex", it.group()) else it.group() }
        run {
            val whole = s
            s = replace(TOKEN, whole) { m ->
                val t = m.group()
                val publicOnion = whole.startsWith(".onion", m.end()) && PUBLIC_HOSTS.contains(t.lowercase() + ".onion")
                if (DIGIT.matcher(t).find() && LETTER.matcher(t).find() && !publicOnion) "b:" + pseudonym(salt, "tok", t) else t
            }
        }
        run {
          val whole = s
          s = replace(IPV4, whole) { m ->
            val all = m.group()
            val a = m.group(1)!!.toInt()
            val b = m.group(2)!!.toInt()
            when {
                PUBLIC_HOSTS.contains(all) -> all
                afterUaProduct(whole.substring(0, m.start())) -> all
                a > 255 || b > 255 -> all
                else -> (if (privateIpv4(a, b)) "lan:" else "ip:") + pseudonym(salt, "ip", all)
            }
          }
        }
        s = replace(MONEY, s) { m ->
            val n = m.group(2)!!.replace(",", "").replace("_", "").toDoubleOrNull() ?: Double.NaN
            val unit = m.group(3)!!
            val sompi = unit.equals("sompi", ignoreCase = true)
            m.group(1)!! + "~" + bucketAmount(if (sompi) n / 1e8 else n) + " " + (if (sompi) "ZKAS" else unit.uppercase())
        }
        if (s.length > max) s = s.substring(0, max) + "…"
        return s
    }
}
