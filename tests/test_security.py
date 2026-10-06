"""HTTP regression tests. Run: python -m unittest discover -s tests -v.

Only a new ignored directory with synthetic data is used. Requires Windows
PowerShell and permission to start a loopback HttpListener.
"""

import copy
import http.client
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[1]
VALID_DATA = {
    "transactions": [{"symbol": "TEST", "type": "BUY", "date": "2026-10-04",
                      "quantity": 2, "price": 10.5, "commission": 0}],
    "quotes": {"TEST": 11},
    "history": {"TEST": {"2026-10-04": 11}},
    "settings": {"target": 100000},
}


@unittest.skipUnless(os.name == "nt", "Windows PowerShell is required")
class ServerSecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        data_root = ROOT / ".data"
        data_root.mkdir(exist_ok=True)
        if not data_root.resolve().is_relative_to(ROOT.resolve()):
            raise RuntimeError("Test data directory must stay inside the repository")
        cls.temp = tempfile.TemporaryDirectory(prefix="security-tests-", dir=data_root)
        cls.test_root = Path(cls.temp.name).resolve()
        if not cls.test_root.is_relative_to(data_root.resolve()):
            raise RuntimeError("Unexpected test cleanup target")
        cls.addClassCleanup(cls.temp.cleanup)
        for name in ("Start-BradTrack.ps1", "index.html", "app.js", "styles.css"):
            shutil.copy2(ROOT / name, cls.test_root / name)
        with socket.socket() as sock:
            for port in range(18766, 18866):
                try:
                    sock.bind(("127.0.0.1", port))
                    break
                except OSError:
                    continue
            else:
                raise RuntimeError("No isolated test port available")
            cls.port = sock.getsockname()[1]
        cls.origin = f"http://127.0.0.1:{cls.port}"
        cls.log = open(cls.test_root / "server.log", "wb")
        cls.addClassCleanup(cls.log.close)
        cls.process = subprocess.Popen(
            ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
             str(cls.test_root / "Start-BradTrack.ps1"), "-Port", str(cls.port)],
            stdout=cls.log, stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        cls.addClassCleanup(cls.stop_server)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if cls.process.poll() is not None:
                raise RuntimeError("Isolated server exited; inspect its startup configuration")
            try:
                status, _, body = cls.request("GET", "/api/session", timeout=5)
                if status == 200:
                    cls.token = json.loads(body)["csrfToken"]
                    break
            except (OSError, http.client.HTTPException):
                time.sleep(0.1)
        else:
            raise RuntimeError("Isolated server did not start: " +
                               (cls.test_root / "server.log").read_text(errors="replace")[-6000:])

    @classmethod
    def stop_server(cls):
        cls.process.terminate()
        try:
            cls.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            cls.process.kill()
            cls.process.wait(timeout=5)

    @classmethod
    def request(cls, method, path, body=None, headers=None, chunked=False, timeout=20):
        connection = http.client.HTTPConnection("127.0.0.1", cls.port, timeout=timeout)
        try:
            try:
                connection.request(method, path, body=body, headers=headers or {}, encode_chunked=chunked)
            except (BrokenPipeError, ConnectionResetError):
                # A server may reject an oversized upload before the sender finishes.
                pass
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    @classmethod
    def write_headers(cls):
        return {"Content-Type": "application/json", "Origin": cls.origin,
                "Sec-Fetch-Site": "same-origin", "X-BradTrack-CSRF": cls.token}

    def post(self, path, data, headers=None):
        return self.request("POST", path, json.dumps(data).encode(),
                            self.write_headers() if headers is None else headers)

    def setUp(self):
        self.assertEqual(self.post("/api/portfolios/default/data", VALID_DATA)[0], 200)
        self.data_file = self.test_root / ".data/portfolios/default/portfolio.json"

    def test_normal_creation_save_and_import(self):
        status, _, body = self.post("/api/portfolios", {"alias": "Synthetic portfolio"})
        self.assertEqual(status, 201)
        portfolio_id = json.loads(body)["id"]
        self.assertEqual(self.post(f"/api/portfolios/{portfolio_id}/data", VALID_DATA)[0], 200)
        status, headers, body = self.request("GET", f"/api/portfolios/{portfolio_id}/data")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), VALID_DATA)
        self.assertEqual(headers["Cache-Control"], "no-store")
        status, _, body = self.post(f"/api/portfolios/{portfolio_id}/imports", {
            "name": "../../synthetic.csv", "category": "transactions", "content": "Symbol,Quantity\nTEST,2\n"})
        self.assertEqual(status, 200)
        import_path = (self.test_root / ".data" / json.loads(body)["file"]).resolve()
        self.assertTrue(import_path.is_relative_to(self.test_root / ".data/imports"))
        self.assertEqual(import_path.read_text(), "Symbol,Quantity\nTEST,2\n")

    def test_all_write_endpoints_reject_foreign_or_missing_origin_and_token(self):
        routes = [("/api/portfolios", {"alias": "Untrusted"}),
                  ("/api/portfolios/default/data", VALID_DATA),
                  ("/api/portfolios/default/imports", {"name": "x.csv", "category": "history", "content": "x"})]
        before = self.data_file.read_bytes()
        index = (self.test_root / ".data/portfolios.json").read_bytes()
        for path, data in routes:
            for field, value in [("Origin", "http://untrusted.example"), ("Origin", None),
                                 ("Origin", self.origin + ".untrusted.example"), ("Origin", "null"),
                                 ("Sec-Fetch-Site", "cross-site"), ("Sec-Fetch-Site", "same-site"),
                                 ("X-BradTrack-CSRF", None), ("X-BradTrack-CSRF", "invalid")]:
                with self.subTest(path=path, field=field, value=value):
                    headers = self.write_headers()
                    if value is None:
                        headers.pop(field)
                    else:
                        headers[field] = value
                    self.assertEqual(self.post(path, data, headers)[0], 403)
        self.assertEqual(self.data_file.read_bytes(), before)
        self.assertEqual((self.test_root / ".data/portfolios.json").read_bytes(), index)

    def test_session_and_reads_reject_foreign_origin(self):
        for path in ("/api/session", "/api/portfolios", "/api/portfolios/default/data"):
            self.assertEqual(self.request("GET", path, headers={"Origin": "http://untrusted.example"})[0], 403)
        self.assertEqual(self.request("OPTIONS", "/api/portfolios", headers={
            "Origin": "http://untrusted.example", "Access-Control-Request-Method": "POST"})[0], 403)

    def test_api_security_cannot_be_bypassed_by_path_case(self):
        index_file = self.test_root / ".data/portfolios.json"
        before = index_file.read_bytes()
        headers = {"Content-Type": "text/plain", "Origin": "http://untrusted.example",
                   "Sec-Fetch-Site": "cross-site"}
        for prefix in ("/API", "/Api", "/aPi"):
            with self.subTest(prefix=prefix):
                self.assertEqual(self.post(prefix + "/portfolios", {"alias": "Untrusted " + prefix}, headers)[0], 403)
                self.assertEqual(self.request("GET", prefix + "/session", headers=headers)[0], 403)
                self.assertEqual(self.request("GET", prefix + "/portfolios", headers=headers)[0], 403)
                for action in ("data", "imports"):
                    self.assertEqual(self.post(prefix + "/portfolios/default/" + action, {}, headers)[0], 403)
        self.assertEqual(index_file.read_bytes(), before)

    def test_content_type_and_utf8_are_enforced(self):
        for content_type in ("text/plain", "application/x-www-form-urlencoded",
                             "application/json; charset=iso-8859-1", ""):
            headers = self.write_headers()
            headers["Content-Type"] = content_type
            self.assertEqual(self.post("/api/portfolios/default/data", VALID_DATA, headers)[0], 415)
        self.assertEqual(self.request("POST", "/api/portfolios/default/data", b"\xff", self.write_headers())[0], 400)

    def test_invalid_data_never_overwrites_previous_file(self):
        before = self.data_file.read_bytes()
        invalid = [[], {"transactions": "invalid", "quotes": None, "history": 42}]
        changes = [("date", "2026-02-31"), ("symbol", "constructor"), ("type", "OTHER"),
                   ("quantity", 0), ("quantity", "2"), ("price", -1), ("commission", -1)]
        for field, value in changes:
            data = copy.deepcopy(VALID_DATA)
            data["transactions"][0][field] = value
            invalid.append(data)
        for field, value in [("quotes", []), ("history", {"TEST": {"2026-02-31": 10}}),
                             ("quotes", {"TEST": True}), ("settings", {"target": -1})]:
            data = copy.deepcopy(VALID_DATA)
            data[field] = value
            invalid.append(data)
        for data in invalid:
            with self.subTest(data=data):
                self.assertEqual(self.post("/api/portfolios/default/data", data)[0], 400)
                self.assertEqual(self.data_file.read_bytes(), before)

    def test_empty_and_legacy_portfolios_still_work(self):
        for data in ({"transactions": [], "quotes": {}, "history": {}},
                     {"transactions": [], "quotes": {}, "history": {}, "settings": {"target": 0}}):
            self.assertEqual(self.post("/api/portfolios/default/data", data)[0], 200)

    def test_top_level_json_arrays_are_rejected_without_writes(self):
        index_file = self.test_root / ".data/portfolios.json"
        index_before = index_file.read_bytes()
        data_before = self.data_file.read_bytes()
        imports_before = list((self.test_root / ".data/imports").rglob("*.csv"))
        cases = [("/api/portfolios", [{"alias": "Array wrapper"}]),
                 ("/api/portfolios/default/data", [VALID_DATA]),
                 ("/api/portfolios/default/imports", [{"name": "x.csv", "category": "history", "content": "x"}])]
        for path, data in cases:
            with self.subTest(path=path):
                self.assertEqual(self.post(path, data)[0], 400)
        self.assertEqual(index_file.read_bytes(), index_before)
        self.assertEqual(self.data_file.read_bytes(), data_before)
        self.assertEqual(list((self.test_root / ".data/imports").rglob("*.csv")), imports_before)

    def test_chunked_oversize_body_is_rejected_without_archive(self):
        before = list((self.test_root / ".data/imports").rglob("*.csv"))
        # No Content-Length: this reproduced the original bypass.
        payload = json.dumps({"name": "oversize.csv", "category": "history",
                              "content": "x" * (15 * 1024 * 1024 + 1)}).encode()
        chunks = (payload[offset:offset + 65536] for offset in range(0, len(payload), 65536))
        self.assertEqual(self.request("POST", "/api/portfolios/default/imports", chunks,
                                      self.write_headers(), True)[0], 413)
        self.assertEqual(list((self.test_root / ".data/imports").rglob("*.csv")), before)
        self.assertEqual(self.request("GET", "/api/portfolios")[0], 200)

    def test_limits_apply_to_creation_and_csv_content(self):
        self.assertEqual(self.post("/api/portfolios", {"alias": "x" * 5000})[0], 413)
        content = "\u20ac" * (10 * 1024 * 1024 // 3 + 1)
        # ensure_ascii=False keeps the JSON body below 15 MiB, while CSV UTF-8 exceeds 10 MiB.
        payload = json.dumps({"name": "oversize.csv", "category": "history", "content": content},
                             ensure_ascii=False).encode()
        self.assertEqual(self.request("POST", "/api/portfolios/default/imports", payload,
                                      self.write_headers())[0], 413)

    def test_declared_oversize_data_is_rejected_before_reading(self):
        before = self.data_file.read_bytes()
        headers = self.write_headers()
        headers["Content-Length"] = str(15 * 1024 * 1024 + 1)
        self.assertEqual(self.request("POST", "/api/portfolios/default/data", b"", headers)[0], 413)
        self.assertEqual(self.data_file.read_bytes(), before)

    def test_disconnected_client_does_not_stop_server_or_change_data(self):
        before = self.data_file.read_bytes()
        headers = self.write_headers()
        headers["Content-Length"] = "100"
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            connection.request("POST", "/api/portfolios/default/data", body=b"{", headers=headers)
        finally:
            connection.close()
        self.assertEqual(self.request("GET", "/api/portfolios")[0], 200)
        self.assertEqual(self.data_file.read_bytes(), before)

    def test_slow_request_expires_and_server_recovers(self):
        headers = self.write_headers()
        headers["Content-Length"] = "100"
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        started = time.monotonic()
        try:
            connection.request("POST", "/api/portfolios", body=b"{", headers=headers)
            response = connection.getresponse()
            self.assertEqual(response.status, 408)
            response.read()
        finally:
            connection.close()
        self.assertLess(time.monotonic() - started, 14)
        self.assertEqual(self.request("GET", "/api/portfolios")[0], 200)

    def test_private_paths_and_security_headers(self):
        for path in ("/.data/portfolios.json", "/.git/config", "/resources/_test.csv", "/Start-BradTrack.ps1"):
            self.assertEqual(self.request("GET", path)[0], 404)
        for path in ("/", "/api/session", "/api/portfolios/default/data"):
            status, headers, _ = self.request("GET", path)
            self.assertEqual(status, 200)
            self.assertEqual(headers["Cache-Control"], "no-store")
            self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
            self.assertEqual(headers["Cross-Origin-Resource-Policy"], "same-origin")
            self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])


class GitIgnoreTests(unittest.TestCase):
    def test_sensitive_paths_are_ignored(self):
        paths = [".data/portfolio.json", "resources/_test.csv", ".venv/pyvenv.cfg", ".env", ".env.local",
                 "nested/.env.production", ".aws/credentials", ".ssh/id_ed25519", "private.pem",
                 "private.key", "certificate.pfx", "credentials.json", "secrets.json", "export.csv",
                 "export.xlsx", "backup.sqlite3", "portfolio-backup.json"]
        result = subprocess.run(["git", "check-ignore", "--no-index", "--stdin", "-z"], cwd=ROOT,
                                input=("\0".join(paths) + "\0").encode(), capture_output=True, check=True)
        self.assertEqual(set(result.stdout.decode().split("\0")[:-1]), set(paths))
        result = subprocess.run(["git", "check-ignore", "--no-index", ".env.example"], cwd=ROOT,
                                capture_output=True)
        self.assertEqual(result.returncode, 1)


if __name__ == "__main__":
    unittest.main()
