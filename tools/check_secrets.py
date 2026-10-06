"""Local, offline safeguards for Git contents. Findings never include secret values.

python tools/check_secrets.py            # current worktree and index
python tools/check_secrets.py --staged   # complete index, suitable for pre-commit
python tools/check_secrets.py --all      # worktree, index and reachable history

This is a preventive pattern scanner, not a guarantee that all secrets or
personal information will be recognized.
"""

import argparse
from collections import Counter
import math
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys


PATTERNS = {
    "private-key": re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----"),
    "aws-key": re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    "github-token": re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b"),
    "openai-token": re.compile(r"\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b"),
    "google-key": re.compile(r"\bAIza[A-Za-z0-9_-]{35}\b"),
    "slack-token": re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b"),
    "jwt": re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"),
    "credential-url": re.compile(r"(?i)\b(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis)://[^\s/:]+:[^\s/@]+@"),
    "iban-es": re.compile(r"\bES\d{22}\b"),
}
ASSIGNMENT = re.compile(
    r'''(?i)\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*(["'])([^"'\r\n]{8,})\1''')
ENV_ASSIGNMENT = re.compile(
    r'''(?mi)^\s*(?:export\s+)?(?:password|passwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)\s*=\s*([^\s"'\x60#]{8,})\s*(?:#.*)?$''')
LITERAL = re.compile(r'''["']([A-Za-z0-9+/=_-]{32,})["']''')
PLACEHOLDERS = {"placeholder", "example", "changeme", "your_api_key", "your_secret", "dummy_value"}


def sensitive_path(name):
    path = PurePosixPath(name.lower())
    if any(part in {".data", "resources", ".aws", ".ssh", ".venv", "venv"} for part in path.parts):
        return True
    filename = path.name
    return (filename in {".env", "credentials.json", "secrets.json", "id_rsa", "id_ed25519"}
            or (filename.startswith(".env.") and filename != ".env.example")
            or (filename.startswith("portfolio") and path.suffix == ".json")
            or path.suffix in {".csv", ".xls", ".xlsx", ".pem", ".key", ".p12", ".pfx",
                               ".db", ".sqlite", ".sqlite3", ".bak"})


def content_findings(data):
    encoding = "utf-16" if data[:2] in (b"\xff\xfe", b"\xfe\xff") else "utf-8"
    text = data.decode(encoding, errors="replace")
    matches = [(rule, match.start()) for rule, pattern in PATTERNS.items() for match in pattern.finditer(text)]
    for match in ASSIGNMENT.finditer(text):
        value = match.group(2)
        if value.lower() not in PLACEHOLDERS and not value.startswith(("${", "$env:")):
            matches.append(("credential-assignment", match.start()))
    for match in ENV_ASSIGNMENT.finditer(text):
        value = match.group(1)
        if value.lower() not in PLACEHOLDERS and not value.startswith(("${", "$env:")):
            matches.append(("credential-assignment", match.start()))
    for match in LITERAL.finditer(text):
        value = match.group(1)
        if re.fullmatch(r"[a-fA-F0-9]+", value):
            continue  # Git commit IDs and ordinary hexadecimal identifiers.
        counts = Counter(value)
        entropy = -sum((count / len(value)) * math.log2(count / len(value)) for count in counts.values())
        if entropy >= 4.5 and re.search(r"[A-Z]", value) and re.search(r"[0-9]", value):
            matches.append(("high-entropy-literal", match.start()))
    return {(rule, text.count("\n", 0, offset) + 1) for rule, offset in matches}


def git(root, *args):
    return subprocess.check_output(["git", *args], cwd=root, stderr=subprocess.PIPE)


def tree_entries(raw):
    for record in raw.split(b"\0"):
        if not record:
            continue
        metadata, name = record.split(b"\t", 1)
        fields = metadata.split()
        oid = fields[2] if fields[1] in (b"blob", b"commit", b"tree") else fields[1]
        yield fields[0].decode(), oid.decode(), name.decode("utf-8", errors="replace")


def audit(root, staged=False, history=False):
    findings = set()
    checked_blobs = set()

    def inspect(name, data, location):
        if sensitive_path(name):
            findings.add((location, "sensitive-path", 0))
        for rule, line in content_findings(data):
            findings.add((location, rule, line))

    def inspect_blob(name, oid, location):
        if sensitive_path(name):
            findings.add((location, "sensitive-path", 0))
        if oid not in checked_blobs:
            checked_blobs.add(oid)
            for rule, line in content_findings(git(root, "cat-file", "blob", oid)):
                findings.add((location, rule, line))

    # Scan the full index, including files previously forced past .gitignore.
    for mode, oid, name in tree_entries(git(root, "ls-files", "--stage", "-z")):
        if mode != "160000":
            inspect_blob(name, oid, "index:" + name)
    if not staged:
        names = set(git(root, "ls-files", "-z").split(b"\0"))
        names.update(git(root, "ls-files", "--others", "--exclude-standard", "-z").split(b"\0"))
        for raw in names - {b""}:
            name = raw.decode("utf-8", errors="replace")
            path = root / name
            if path.is_file() and not path.is_symlink():
                inspect(name, path.read_bytes(), "worktree:" + name)
    if history:
        for commit in git(root, "rev-list", "--all").decode().splitlines():
            for mode, oid, name in tree_entries(git(root, "ls-tree", "-r", "-z", commit)):
                if mode != "160000":  # submodule entries are commits, not blobs
                    inspect_blob(name, oid, "history:" + commit[:12] + ":" + name)
    return sorted(findings)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    scope = parser.add_mutually_exclusive_group()
    scope.add_argument("--staged", action="store_true")
    scope.add_argument("--all", action="store_true")
    args = parser.parse_args()
    try:
        root = Path(git(Path.cwd(), "rev-parse", "--show-toplevel").decode().strip())
        findings = audit(root, staged=args.staged, history=args.all)
    except (OSError, subprocess.CalledProcessError):
        print("Security check could not read Git contents.", file=sys.stderr)
        return 2
    for location, rule, line in findings:
        print(f"{location}:{line}: {rule} (value hidden)")
    if findings:
        print("Security check failed. Remove sensitive content from the index/history before continuing.")
        return 1
    print("Security check passed: no sensitive paths or matching secret patterns.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
