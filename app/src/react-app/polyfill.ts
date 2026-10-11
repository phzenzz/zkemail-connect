// Must load before any @solana/* / anchor / circomlibjs modules.
import { Buffer } from "buffer";
import process from "process";

const g = globalThis as typeof globalThis & {
  Buffer?: typeof Buffer;
  process?: typeof process;
};

if (!g.Buffer) g.Buffer = Buffer;
if (!g.process) g.process = process;
