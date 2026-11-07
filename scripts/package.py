"""Package a published build and add it to the plugin repository manifest.

package:  python3 scripts/package.py package --version 0.1.0.0 --publish-dir publish --out dist --changelog "..."
manifest: python3 scripts/package.py manifest --zip dist/disc-menu_0.1.0.0.zip --url https://.../disc-menu_0.1.0.0.zip

Uses the standard library only. Plugin metadata comes from plugin.json; the version comes from the release tag.
"""

import argparse
import datetime
import hashlib
import json
import pathlib
import re
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+\.\d+$")


def load_plugin() -> dict:
    return json.loads((ROOT / "plugin.json").read_text())


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def package(args: argparse.Namespace) -> None:
    if not VERSION_RE.match(args.version):
        sys.exit(f"version must have four parts, got {args.version!r}")
    plugin = load_plugin()
    meta = {
        "category": plugin["category"],
        "changelog": args.changelog,
        "description": plugin["description"],
        "guid": plugin["guid"],
        "name": plugin["name"],
        "overview": plugin["overview"],
        "owner": plugin["owner"],
        "targetAbi": plugin["targetAbi"],
        "timestamp": datetime.datetime.now(datetime.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "version": args.version,
    }
    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    zip_path = out / f"{slug(plugin['name'])}_{args.version}.zip"
    publish = pathlib.Path(args.publish_dir)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in plugin["artifacts"]:
            src = publish / name
            if not src.is_file():
                sys.exit(f"missing build artifact: {src}")
            zf.write(src, name)
        zf.writestr("meta.json", json.dumps(meta, indent=4) + "\n")
    print(zip_path)


def manifest(args: argparse.Namespace) -> None:
    zip_path = pathlib.Path(args.zip)
    with zipfile.ZipFile(zip_path) as zf:
        meta = json.loads(zf.read("meta.json"))
    checksum = hashlib.md5(zip_path.read_bytes()).hexdigest()  # noqa: S324 - Jellyfin's manifest checksum is MD5
    entry = {
        "version": meta["version"],
        "changelog": meta["changelog"],
        "targetAbi": meta["targetAbi"],
        "sourceUrl": args.url,
        "checksum": checksum,
        "timestamp": meta["timestamp"],
    }
    path = ROOT / "manifest.json"
    repo = json.loads(path.read_text())
    plugin = next((p for p in repo if p["guid"] == meta["guid"]), None)
    if plugin is None:
        plugin = {"guid": meta["guid"], "versions": []}
        repo.append(plugin)
    plugin.update(
        name=meta["name"],
        description=meta["description"],
        overview=meta["overview"],
        owner=meta["owner"],
        category=meta["category"],
    )
    if any(v["version"] == entry["version"] for v in plugin["versions"]):
        sys.exit(f"manifest already lists version {entry['version']}")
    # Newest first, as Jellyfin's own repository lists them.
    plugin["versions"] = [entry, *plugin["versions"]]
    path.write_text(json.dumps(repo, indent=4) + "\n")
    print(f"added {meta['name']} {entry['version']} to {path.name}")


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(required=True)
    p = sub.add_parser("package")
    p.add_argument("--version", required=True)
    p.add_argument("--publish-dir", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--changelog", required=True)
    p.set_defaults(func=package)
    m = sub.add_parser("manifest")
    m.add_argument("--zip", required=True)
    m.add_argument("--url", required=True)
    m.set_defaults(func=manifest)
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
