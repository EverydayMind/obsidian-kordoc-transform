import JSZip from "jszip";
import { checkZipDirectoryIdentity } from "./zip-consistency";
import { verifyEmptyDirectory, verifyInflatedBudget } from "./zip-budget";
import { verifyRecoveryBudget } from "./zip-recovery-budget";

/** Guard ZIP-based documents before the bundled engine reads or writes them.
 * Archives that JSZip cannot open retain the engine's damaged-HWPX recovery,
 * after a separate bounded scan of the sections that recovery can inflate. */
export async function guardZipInput(input: ArrayBuffer | Uint8Array, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b ||
      !((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6))) return;
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(bytes); } catch { signal?.throwIfAborted(); await verifyRecoveryBudget(bytes, undefined, signal); return; }
  signal?.throwIfAborted();
  const compressedDirectories = checkZipDirectoryIdentity(bytes);
  // JSZip has already discarded directory contents; inspect the original bytes
  // before passing the archive to the engine or its independent parsers.
  for (const compressed of compressedDirectories) {
    signal?.throwIfAborted();
    await verifyEmptyDirectory(compressed, signal);
  }
  signal?.throwIfAborted();
  await verifyInflatedBudget(zip, 256 * 1024 * 1024, signal);
}
