import { createRequire } from "node:module";

type WindowsProcessObservation = {
  pid: number;
  parentPid?: number;
  startIdentity?: string;
  commandLine?: string;
  cwd?: string;
  foreignOwner?: true;
};
let native: ReturnType<typeof loadNative> | undefined;

function loadNative() {
  if (process.arch !== "x64" && process.arch !== "arm64") {
    throw new Error("Windows process census requires a 64-bit runtime.");
  }
  const koffi: typeof import("koffi").default = createRequire(import.meta.url)("koffi");
  const kernel = koffi.load("kernel32.dll");
  const security = koffi.load("advapi32.dll");
  const nt = koffi.load("ntdll.dll");
  const enumerate = kernel.func("int32_t __stdcall K32EnumProcesses(void *, uint32_t, void *)");
  const open = kernel.func("void * __stdcall OpenProcess(uint32_t, int32_t, uint32_t)");
  const close = kernel.func("int32_t __stdcall CloseHandle(void *)");
  const error = kernel.func("uint32_t __stdcall GetLastError()");
  const wait = kernel.func("uint32_t __stdcall WaitForSingleObject(void *, uint32_t)");
  const times = kernel.func(
    "int32_t __stdcall GetProcessTimes(void *, void *, void *, void *, void *)",
  );
  const read = kernel.func(
    "int32_t __stdcall ReadProcessMemory(void *, uintptr_t, void *, size_t, void *)",
  );
  const query = nt.func(
    "int32_t __stdcall NtQueryInformationProcess(void *, uint32_t, void *, uint32_t, void *)",
  );
  const current = kernel.func("void * __stdcall GetCurrentProcess()");
  const openToken = security.func("int32_t __stdcall OpenProcessToken(void *, uint32_t, void *)");
  const tokenInfo = security.func(
    "int32_t __stdcall GetTokenInformation(void *, uint32_t, void *, uint32_t, void *)",
  );
  const equalSid = security.func("int32_t __stdcall EqualSid(void *, void *)");
  const user = (handle: bigint): Buffer | undefined => {
    const token = Buffer.alloc(8);
    if (!openToken(handle, 8, token)) {
      return undefined;
    }
    try {
      // TOKEN_USER plus SECURITY_MAX_SID_SIZE; the kernel points into this retained buffer.
      const info = Buffer.alloc(16 + 68);
      return tokenInfo(token.readBigUInt64LE(), 1, info, info.length, Buffer.alloc(4))
        ? info
        : undefined;
    } finally {
      close(token.readBigUInt64LE());
    }
  };
  const memory = (handle: bigint, address: bigint, length: number): Buffer => {
    const bytes = Buffer.alloc(length);
    const returned = Buffer.alloc(8);
    if (
      !address ||
      !read(handle, address, bytes, length, returned) ||
      returned.readBigUInt64LE() !== BigInt(length)
    ) {
      throw new Error("Process memory is unreadable.");
    }
    return bytes;
  };
  const parameters = (handle: bigint, observation: WindowsProcessObservation) => {
    const basic = Buffer.alloc(48);
    const wow64 = Buffer.alloc(8);
    const returned = Buffer.alloc(4);
    if (
      query(handle, 0, basic, basic.length, returned) < 0 ||
      returned.readUInt32LE() !== basic.length ||
      basic.readBigUInt64LE(32) !== BigInt(observation.pid) ||
      query(handle, 26, wow64, wow64.length, returned) < 0 ||
      returned.readUInt32LE() !== wow64.length
    ) {
      throw new Error("Process identity or architecture is unavailable.");
    }
    const narrow = wow64.readBigUInt64LE() !== 0n;
    const pointer = (bytes: Buffer, offset: number) =>
      narrow ? BigInt(bytes.readUInt32LE(offset)) : bytes.readBigUInt64LE(offset);
    // NT layouts: PEB.ProcessParameters, then RTL_USER_PROCESS_PARAMETERS strings.
    const peb = narrow ? wow64.readBigUInt64LE() : basic.readBigUInt64LE(8);
    const address = pointer(memory(handle, peb, narrow ? 20 : 40), narrow ? 16 : 32);
    const header = memory(handle, address, narrow ? 72 : 128);
    const string = (offset: number): string | undefined => {
      try {
        const length = header.readUInt16LE(offset);
        if (!length || length % 2 || length > header.readUInt16LE(offset + 2)) {
          return undefined;
        }
        const value = pointer(header, offset + (narrow ? 4 : 8));
        const location = header.readUInt32LE(8) & 1 ? value : address + value;
        return memory(handle, location, length).toString("utf16le");
      } catch {
        return undefined;
      }
    };
    observation.parentPid = Number(basic.readBigUInt64LE(40));
    observation.commandLine = string(narrow ? 64 : 112);
    observation.cwd = string(narrow ? 36 : 56);
  };
  return (deadline: number): WindowsProcessObservation[] => {
    const currentUser = user(current());
    const bytes = Buffer.alloc(4 * 65_536);
    const returned = Buffer.alloc(4);
    if (
      !enumerate(bytes, bytes.length, returned) ||
      returned.readUInt32LE() >= bytes.length ||
      returned.readUInt32LE() % 4
    ) {
      throw new Error("Windows process enumeration is incomplete.");
    }
    const pids = new Uint32Array(bytes.buffer, bytes.byteOffset, returned.readUInt32LE() / 4);
    const observations = Array.from(pids, (pid): WindowsProcessObservation | undefined => {
      if (Date.now() >= deadline) {
        throw new Error("Windows process census exceeded its deadline.");
      }
      if (pid === 0 || pid === 4) {
        // Idle/System have no user-mode argv/cwd.
        return undefined;
      }
      // The handle pins identity for creation time, argv, cwd and owner reads.
      let handle: bigint | null = open(0x0010_0410, 0, pid);
      if (!handle && error() !== 87) {
        handle = open(0x0010_1000, 0, pid);
      }
      if (!handle) {
        return error() === 87 ? undefined : { pid };
      }
      const observation: WindowsProcessObservation = { pid };
      try {
        const state = wait(handle, 0);
        if (state !== 258) {
          return state === 0 ? undefined : observation;
        }
        const created = Buffer.alloc(8);
        if (
          times(handle, created, Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)) &&
          created.readBigUInt64LE()
        ) {
          observation.startIdentity = String(
            Number(created.readBigUInt64LE() / 10000n - 11644473600000n),
          );
        }
        try {
          parameters(handle, observation);
        } catch {
          // Partial inspection remains unknown; verified foreign work can still be excluded.
        }
        const owner = !observation.commandLine || !observation.cwd ? user(handle) : undefined;
        if (
          currentUser &&
          owner &&
          !equalSid(currentUser.readBigUInt64LE(), owner.readBigUInt64LE())
        ) {
          observation.foreignOwner = true;
        }
      } finally {
        close(handle);
      }
      return observation;
    });
    if (Date.now() >= deadline) {
      throw new Error("Windows process census exceeded its deadline.");
    }
    return observations.filter((observation) => observation !== undefined);
  };
}

/** Missing fields never establish absence for same-user or unknown-owner work. */
export function readWindowsProcessCensus(timeoutMs: number): WindowsProcessObservation[] {
  const deadline = Date.now() + timeoutMs;
  return (native ??= loadNative())(deadline);
}
