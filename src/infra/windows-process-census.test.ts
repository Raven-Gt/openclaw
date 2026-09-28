import { beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  K32EnumProcesses: vi.fn(),
  OpenProcess: vi.fn(),
  CloseHandle: vi.fn(),
  GetLastError: vi.fn(),
  WaitForSingleObject: vi.fn(),
  GetProcessTimes: vi.fn(),
  NtQueryInformationProcess: vi.fn(),
  ReadProcessMemory: vi.fn(),
  GetCurrentProcess: vi.fn(),
  OpenProcessToken: vi.fn(),
  GetTokenInformation: vi.fn(),
  EqualSid: vi.fn(),
}));
vi.mock("node:module", () => ({
  createRequire: () => () => ({
    load: () => ({
      func: (signature: string) => {
        const binding = Object.entries(native).find(([name]) => signature.includes(`${name}(`));
        if (!binding) {
          throw new Error("Unexpected native binding");
        }
        return binding[1];
      },
    }),
  }),
}));
import { readWindowsProcessCensus } from "./windows-process-census.js";

const pid = 120;
const handle = 12n;
const memory = new Map<bigint, Buffer>();
let narrow = false;

beforeEach(() => {
  narrow = false;
  memory.clear();
  native.K32EnumProcesses.mockReset().mockImplementation(
    (bytes: Buffer, _size, returned: Buffer) => {
      [0, 4, pid].forEach((value, index) => bytes.writeUInt32LE(value, index * 4));
      returned.writeUInt32LE(12);
      return 1;
    },
  );
  native.OpenProcess.mockReset().mockReturnValue(handle);
  native.CloseHandle.mockReset().mockReturnValue(1);
  native.GetLastError.mockReset().mockReturnValue(5);
  native.WaitForSingleObject.mockReset().mockReturnValue(258);
  native.GetCurrentProcess.mockReset().mockReturnValue(-1n);
  native.OpenProcessToken.mockReset().mockReturnValue(0);
  native.GetTokenInformation.mockReset().mockReturnValue(0);
  native.EqualSid.mockReset().mockImplementation((left, right) => Number(left === right));
  native.GetProcessTimes.mockReset().mockImplementation((_handle, creation: Buffer) => {
    creation.writeBigUInt64LE(133_700_000_000_000_001n);
    return 1;
  });
  native.NtQueryInformationProcess.mockReset().mockImplementation(
    (_handle, kind, bytes: Buffer, _size, returned: Buffer) => {
      returned.writeUInt32LE(bytes.length);
      if (kind === 0) {
        bytes.writeBigUInt64LE(0x1000n, 8);
        bytes.writeBigUInt64LE(BigInt(pid), 32);
        bytes.writeBigUInt64LE(100n, 40);
      } else if (kind === 26) {
        bytes.writeBigUInt64LE(narrow ? 0x1000n : 0n);
      } else {
        throw new Error("Unexpected native process information class");
      }
      return 0;
    },
  );
  native.ReadProcessMemory.mockReset().mockImplementation(
    (_handle, address: bigint, bytes: Buffer, _size, returned: Buffer) => {
      const source = memory.get(address);
      if (!source) {
        return 0;
      }
      source.copy(bytes);
      returned.writeBigUInt64LE(BigInt(source.length));
      return 1;
    },
  );
});

function processParameters() {
  const peb = Buffer.alloc(narrow ? 20 : 40);
  const parameters = Buffer.alloc(narrow ? 72 : 128);
  const pointer = (bytes: Buffer, offset: number, value: number) => {
    if (narrow) {
      bytes.writeUInt32LE(value, offset);
    } else {
      bytes.writeBigUInt64LE(BigInt(value), offset);
    }
  };
  pointer(peb, narrow ? 16 : 32, 0x2000);
  parameters.writeUInt32LE(1, 8);
  const unicode = (offset: number, address: number, text: string) => {
    const bytes = Buffer.from(text, "utf16le");
    parameters.writeUInt16LE(bytes.length, offset);
    parameters.writeUInt16LE(bytes.length, offset + 2);
    pointer(parameters, offset + (narrow ? 4 : 8), address);
    memory.set(BigInt(address), bytes);
  };
  unicode(narrow ? 36 : 56, 0x3000, "C:\\retained runtime\\工作");
  unicode(narrow ? 64 : 112, 0x4000, 'node "C:\\retained runtime\\worker.js" --run=run-123');
  memory.set(0x1000n, peb);
  memory.set(0x2000n, parameters);
}

it.each([false, true])(
  "reads native/WOW64 argv, cwd and the canonical start identity (WOW64=%s)",
  (wow64) => {
    narrow = wow64;
    processParameters();
    expect([...readWindowsProcessCensus(1_000)]).toEqual([
      {
        pid,
        parentPid: 100,
        startIdentity: "1725526400000",
        commandLine: 'node "C:\\retained runtime\\worker.js" --run=run-123',
        cwd: "C:\\retained runtime\\工作",
      },
    ]);
    expect(native.CloseHandle).toHaveBeenCalledWith(handle);
  },
);

it.each([
  "denied handle",
  "denied memory",
  "short memory",
  "incomplete string",
  "identity changed",
])("keeps %s observations unknown", (failure) => {
  processParameters();
  if (failure === "denied handle") {
    native.OpenProcess.mockReturnValue(null);
  } else if (failure === "denied memory") {
    native.ReadProcessMemory.mockReturnValue(0);
  } else if (failure === "short memory") {
    memory.set(0x3000n, Buffer.from("x", "utf16le"));
  } else if (failure === "incomplete string") {
    memory.get(0x2000n)!.writeUInt16LE(1, 56);
  } else {
    native.NtQueryInformationProcess.mockImplementation(
      (_handle, _kind, bytes: Buffer, _size, returned: Buffer) => {
        returned.writeUInt32LE(bytes.length);
        bytes.writeBigUInt64LE(BigInt(pid + 1), 32);
        return 0;
      },
    );
  }
  const [observed] = readWindowsProcessCensus(1_000);
  expect(observed).toMatchObject({ pid });
  expect(observed?.cwd).toBeUndefined();
  expect(observed?.foreignOwner).toBeUndefined();
});

function processOwner(same: boolean) {
  native.OpenProcessToken.mockImplementation((processHandle, _access, token: Buffer) => {
    token.writeBigUInt64LE(processHandle === -1n ? 21n : 22n);
    return 1;
  });
  native.GetTokenInformation.mockImplementation((token, _kind, output: Buffer) => {
    output.writeBigUInt64LE(token === 21n || same ? 0x1000n : 0x2000n);
    return 1;
  });
}

it.each([false, true])(
  "excludes opaque work only with a verified foreign SID (same owner=%s)",
  (same) => {
    processOwner(same);
    native.OpenProcess.mockImplementation((access) => (access === 0x0010_1000 ? handle : null));
    const [observed] = readWindowsProcessCensus(1_000);
    expect(observed).toMatchObject({ pid, startIdentity: "1725526400000" });
    expect(observed?.foreignOwner).toBe(same ? undefined : true);
  },
);

it("preserves readable foreign argv when cwd inspection is denied", () => {
  processOwner(false);
  processParameters();
  memory.delete(0x3000n);
  expect([...readWindowsProcessCensus(1_000)]).toEqual([
    {
      pid,
      parentPid: 100,
      startIdentity: "1725526400000",
      commandLine: 'node "C:\\retained runtime\\worker.js" --run=run-123',
      cwd: undefined,
      foreignOwner: true,
    },
  ]);
});

it.each(["absent", "exited"])("excludes a kernel-confirmed %s process", (state) => {
  if (state === "absent") {
    native.OpenProcess.mockReturnValue(null);
    native.GetLastError.mockReturnValue(87);
  } else {
    native.WaitForSingleObject.mockReturnValue(0);
  }
  expect([...readWindowsProcessCensus(1_000)]).toEqual([]);
});

it("rejects a truncated PID census instead of claiming the host is empty", () => {
  native.K32EnumProcesses.mockImplementation((_bytes, size, returned: Buffer) => {
    returned.writeUInt32LE(size);
    return 1;
  });
  expect(() => [...readWindowsProcessCensus(1_000)]).toThrow("enumeration is incomplete");
});
