import { describe, expect, it } from "bun:test";
// bun test shares one module registry across test files: queue.test.ts registers a partial
// mock.module() for machine.js that outlives its file, so a plain import here loses
// macMachineId whenever queue runs first. The query-qualified relative specifier loads this
// module as its own instance, beyond the mock registry's reach.
const machine = "../../../src/reconcile/pr-cost-reporting/machine.js?independent";
const { macMachineId, windowsMachineId } = (await import(
  machine
)) as typeof import("../../../src/reconcile/pr-cost-reporting/machine.js");

describe("machine identity", () => {
  it("reads the hardware UUID from ioreg output", () => {
    const output = `+-o J316sAP  <class IOPlatformExpertDevice, id 0x100000255, registered, matched, active, busy 0 (91 ms), retain 34>
    {
      "IOPlatformSerialNumber" = "ABC123"
      "IOPlatformUUID" = "4C4C4544-0032-3910-8044-B4C04F4B4D32"
    }`;
    expect(macMachineId(output)).toBe("4C4C4544-0032-3910-8044-B4C04F4B4D32");
    expect(macMachineId("{}")).toBeUndefined();
  });

  it("reads MachineGuid from reg query output", () => {
    const output =
      "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    6c0f0d8a-0c5e-4d6b-9a4b-0f1b2c3d4e5f\r\n";
    expect(windowsMachineId(output)).toBe("6c0f0d8a-0c5e-4d6b-9a4b-0f1b2c3d4e5f");
    expect(
      windowsMachineId("ERROR: The system was unable to find the specified registry key or value."),
    ).toBeUndefined();
  });
});
