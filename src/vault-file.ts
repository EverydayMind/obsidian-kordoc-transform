import type { TAbstractFile, TFile, Vault } from "obsidian";

const isFile = (file: TAbstractFile | null): file is TFile => !!file && "extension" in file && "stat" in file;

/**
 * Vault.getFileByPath exists from Obsidian 1.5.7 (minAppVersion is 1.4.0);
 * older versions resolve the abstract file and keep it only when it is a file.
 * The method is read through an optional type so no call depends on the newer typings.
 */
export function vaultFileByPath(vault: Vault, path: string): TFile | null {
  const lookup = vault as { getFileByPath?: (path: string) => TFile | null };
  if (typeof lookup.getFileByPath === "function") return lookup.getFileByPath(path);
  const candidate = vault.getAbstractFileByPath(path);
  return isFile(candidate) ? candidate : null;
}
