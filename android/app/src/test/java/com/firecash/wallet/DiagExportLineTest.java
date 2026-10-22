package com.firecash.wallet;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

/** What survives into an export from a log file that went through a power cut. */
public class DiagExportLineTest {
  private static String nuls(int n) {
    return new String(new char[n]);
  }

  @Test
  public void anOrdinaryLineIsUnchanged() {
    String l = "{\"cat\":\"app\",\"ev\":\"boot\"}";
    assertEquals(l, DiagStore.exportLine(l));
  }

  @Test
  public void nulPaddingBeforeAGoodEventIsDroppedAndTheEventKept() {
    // The shape the emulator crash left: a NUL run, then the next session's first event.
    String ev = "{\"src\":\"android\",\"cat\":\"app\",\"ev\":\"process_start\",\"since_process_start_ms\":3376}";
    assertEquals(ev, DiagStore.exportLine(nuls(1344) + ev));
  }

  @Test
  public void aLineOfOnlyNulsIsLeftOut() {
    assertNull(DiagStore.exportLine(nuls(1738)));
  }

  @Test
  public void aTornLineIsLeftOut() {
    assertNull(DiagStore.exportLine("{\"cat\":\"perf\",\"ev\":\"jank\",\"fra" + nuls(40)));
    assertNull(DiagStore.exportLine(""));
  }
}
