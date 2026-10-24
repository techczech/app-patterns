import { describe, expect, test } from "bun:test";
import { isCloudSyncedLocation, isNetworkMount, mountFor, parseMountTable, type LocationEnvironment } from "./location.ts";

const mac: LocationEnvironment = { homeDir: "/Users/writer", platform: "darwin" };
const linux: LocationEnvironment = { homeDir: "/home/writer", platform: "linux" };
const windows: LocationEnvironment = {
  homeDir: "C:\\Users\\writer",
  platform: "win32",
  env: { OneDrive: "D:\\Sync\\OneDrive - Example", onedrivecommercial: "E:\\Work Sync" },
};

describe("cloud-synced locations", () => {
  const cases: [string, LocationEnvironment, string, string | null][] = [
    ["File Provider folder", mac, "/Users/writer/Library/CloudStorage/OneDrive-Example/vault", "cloud-storage"],
    ["Google Drive via File Provider", mac, "/Users/writer/Library/CloudStorage/GoogleDrive-a@example.invalid/My Drive/vault", "cloud-storage"],
    ["CloudStorage folder itself", mac, "/Users/writer/Library/CloudStorage", "cloud-storage"],
    ["iCloud Drive", mac, "/Users/writer/Library/Mobile Documents/com~apple~CloudDocs/vault", "icloud-drive"],
    ["home OneDrive folder", mac, "/Users/writer/OneDrive - Example/notes", "home-sync-folder"],
    ["home OneDrive, other case", mac, "/Users/writer/onedrive/notes", "home-sync-folder"],
    ["home Dropbox", linux, "/home/writer/Dropbox/vault", "home-sync-folder"],
    ["home Google Drive", mac, "/Users/writer/Google Drive/vault", "home-sync-folder"],
    ["Windows OneDrive env folder", windows, "D:\\Sync\\OneDrive - Example\\vault", "onedrive-folder"],
    ["Windows env name in any case", windows, "e:\\work sync\\vault", "onedrive-folder"],
    ["Windows home OneDrive", windows, "C:\\Users\\writer\\OneDrive\\vault", "home-sync-folder"],
    ["ordinary folder", mac, "/Users/writer/Documents/vault", null],
    ["Dropbox folder deeper down", mac, "/Users/writer/Documents/Dropbox/vault", "home-sync-folder"],
    ["OneDrive folder deeper down", linux, "/home/writer/work/OneDrive - Example/vault", "home-sync-folder"],
    ["Dropbox-prefixed name is not Dropbox", mac, "/Users/writer/Dropbox notes/vault", null],
    ["look-alike prefix of CloudStorage", mac, "/Users/writer/Library/CloudStorageOld/vault", null],
    ["outside home", linux, "/srv/vaults/notes", null],
    ["Windows env folders only apply on Windows", { ...mac, env: { OneDrive: "/Users/writer/Documents" } }, "/Users/writer/Documents/vault", null],
  ];
  for (const [name, env, path, kind] of cases) {
    test(name, () => {
      const result = isCloudSyncedLocation(path, env);
      if (kind === null) expect(result).toEqual({ cloud: false });
      else expect(result).toMatchObject({ cloud: true, kind });
    });
  }
});

describe("mount table", () => {
  const macTable = [
    "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
    "/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)",
    "//writer@fileserver/Shared Docs on /Volumes/Shared Docs (smbfs, nodev, nosuid, mounted by writer)",
    "fuse-t:/remote on /Volumes/remote (nfs, nodev, nosuid, mounted by writer)",
    "/dev/disk5s1 on /Volumes/USB Stick (msdos, local, nodev, nosuid, noowners)",
    "odd-device on /Volumes/odd (somefs, nodev)",
  ].join("\n");

  test("macOS: network types and mounts without the local flag count as network", () => {
    const entries = parseMountTable(macTable, "darwin");
    const at = (p: string) => mountFor(p, entries)!;
    expect(at("/Volumes/Shared Docs/vault").mountPoint).toBe("/Volumes/Shared Docs");
    expect(isNetworkMount(at("/Volumes/Shared Docs/vault"))).toBe(true);
    expect(isNetworkMount(at("/Volumes/remote/vault"))).toBe(true);
    expect(isNetworkMount(at("/Volumes/odd/vault"))).toBe(true);
    expect(isNetworkMount(at("/Volumes/USB Stick/vault"))).toBe(false);
    expect(at("/System/Volumes/Data/vault").mountPoint).toBe("/System/Volumes/Data");
    expect(isNetworkMount(at("/Users/writer/vault"))).toBe(false);
  });

  test("Linux: octal-escaped mount points and network types", () => {
    const table = "/dev/sda1 / ext4 rw 0 0\nserver:/export /mnt/team\\040share nfs4 rw 0 0\n";
    const entries = parseMountTable(table, "linux");
    expect(isNetworkMount(mountFor("/mnt/team share/vault", entries)!)).toBe(true);
    expect(isNetworkMount(mountFor("/home/writer/vault", entries)!)).toBe(false);
  });
});
