package com.firecash.wallet;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.junit.Test;

/**
 * The Kotlin port of the diagnostic log's redactor must produce exactly what the canonical
 * JavaScript redactor (src/diag/redact.ts) does, for every vector in the shared file. The
 * Rust port is held to the same file by `cargo test`, so the three cannot drift apart.
 *
 * Parsed by hand: org.json is a stub in local JVM unit tests.
 */
public class DiagRedactTest {

  private static String unescape(String s) {
    StringBuilder out = new StringBuilder();
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      if (c != '\\') { out.append(c); continue; }
      char n = s.charAt(++i);
      switch (n) {
        case 'n': out.append('\n'); break;
        case 't': out.append('\t'); break;
        case '"': out.append('"'); break;
        case '\\': out.append('\\'); break;
        case '/': out.append('/'); break;
        case 'u': out.append((char) Integer.parseInt(s.substring(i + 1, i + 5), 16)); i += 4; break;
        default: out.append(n);
      }
    }
    return out.toString();
  }

  private static File vectors() {
    // Gradle runs unit tests with the module directory (android/app) as the working dir.
    for (String p : new String[] {"../../test/diag-redaction-vectors.json", "../test/diag-redaction-vectors.json", "test/diag-redaction-vectors.json"}) {
      File f = new File(p);
      if (f.exists()) return f;
    }
    throw new AssertionError("test/diag-redaction-vectors.json not found from " + new File(".").getAbsolutePath());
  }

  @Test
  public void matchesTheSharedVectors() throws Exception {
    String json = new String(Files.readAllBytes(vectors().toPath()), StandardCharsets.UTF_8);
    Matcher salt = Pattern.compile("\"salt\":\\s*\"([0-9a-f]+)\"").matcher(json);
    assertTrue(salt.find());
    Matcher max = Pattern.compile("\"max\":\\s*(\\d+)").matcher(json);
    assertTrue(max.find());
    Matcher c = Pattern.compile("\"input\":\\s*\"((?:[^\"\\\\]|\\\\.)*)\",\\s*\"expect\":\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").matcher(json);
    int n = 0;
    while (c.find()) {
      String input = unescape(c.group(1));
      String expect = unescape(c.group(2));
      List<String> none = Collections.emptyList();
      assertEquals("input: " + input, expect, DiagRedact.INSTANCE.scrub(input, Integer.parseInt(max.group(1)), salt.group(1), none));
      n++;
    }
    assertTrue("too few vectors: " + n, n > 15);
  }

  @Test
  public void knownSecretsAreReplacedByValue() {
    String token = "Ab3dE5gH7jK9mN1pQ3sT5vW7yZ9aB1cD";
    List<String> known = new ArrayList<>();
    known.add(token);
    String out = DiagRedact.INSTANCE.scrub("wallet '" + token + "': opened", 600, "00", known);
    assertFalse(out, out.contains(token));
  }

  @Test
  public void aWholeJsonLineStaysParseableShape() {
    String line = "{\"cat\":\"err\",\"msg\":\"paying zkas:py82h42m9qjff0knpcmllzq3c7qhurje5auh4tq2ceagf69wjpf23djwwmqr26zhsua8rrglrwdltsh 12.5 ZKAS\"}";
    String out = DiagRedact.INSTANCE.scrub(line, Integer.MAX_VALUE, "00", Collections.<String>emptyList());
    assertTrue(out, out.startsWith("{\"cat\":\"err\",\"msg\":\"paying addr:"));
    assertTrue(out, out.endsWith(" ~10-100 ZKAS\"}"));
  }
}
