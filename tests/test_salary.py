"""Payroll calculations and UI in a real headless browser, with synthetic data.

Run: python -m unittest discover -s tests -p test_salary.py -v
Requires Chrome/Edge and the optional websocket-client Python package.
The application itself has no new dependencies. No portfolio API is contacted.
"""

import base64
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
BROWSER = next((path for path in (
    Path(os.environ.get("PROGRAMFILES(X86)", "")) / "Microsoft/Edge/Application/msedge.exe",
    Path(os.environ.get("PROGRAMFILES", "")) / "Google/Chrome/Application/chrome.exe",
) if path.is_file()), None)


@unittest.skipUnless(BROWSER and importlib.util.find_spec("websocket"), "Chrome/Edge and websocket-client required")
class SalaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import websocket

        data_root = ROOT / ".data"
        data_root.mkdir(exist_ok=True)
        cls.temp = tempfile.TemporaryDirectory(prefix="salary-tests-", dir=data_root)
        cls.temp_root = Path(cls.temp.name).resolve()
        if not cls.temp_root.is_relative_to(data_root.resolve()):
            raise RuntimeError("Test directory must remain inside .data")
        cls.addClassCleanup(cls.temp.cleanup)
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        logo_url = "data:image/png;base64," + base64.b64encode((ROOT / "assets/bradtrack-mark.png").read_bytes()).decode()
        html = html.replace('"/assets/bradtrack-mark.png?v=3"', json.dumps(logo_url))
        css = (ROOT / "styles.css").read_text(encoding="utf-8").replace('/assets/bradtrack-mark.png?v=3', logo_url)
        html = html.replace('<link rel="stylesheet" href="/styles.css">', '<style>' + css + '</style>')
        html = html.replace('<script src="/app.js" defer></script>', '''<script>
          window.testErrors = [];
          window.addEventListener('error', e => testErrors.push(e.message));
          window.fetch = () => new Promise(() => {});
        </script>''')
        html = html.replace('</body>', '<script>' + (ROOT / "app.js").read_text(encoding="utf-8") + '</script></body>')
        page = cls.temp_root / "preview.html"
        page.write_text(html, encoding="utf-8")
        cls.process = subprocess.Popen([
            str(BROWSER), "--headless=new", "--disable-gpu", "--no-first-run",
            "--no-default-browser-check", "--remote-debugging-port=0",
            "--remote-allow-origins=http://localhost", "--window-size=1365,1000",
            "--user-data-dir=" + str(cls.temp_root / "browser"), "about:blank",
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        cls.addClassCleanup(cls.stop_browser)
        active_port = cls.temp_root / "browser/DevToolsActivePort"
        deadline = time.monotonic() + 20
        while not active_port.exists():
            if cls.process.poll() is not None or time.monotonic() > deadline:
                raise RuntimeError("Headless browser did not start")
            time.sleep(0.1)
        port = active_port.read_text().splitlines()[0]
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list") as response:
            target = next(item for item in json.load(response) if item["type"] == "page")
        cls.ws = websocket.create_connection(target["webSocketDebuggerUrl"], origin="http://localhost", timeout=10)
        cls.addClassCleanup(cls.ws.close)
        cls.sequence = 0
        cls.call("Page.navigate", {"url": page.as_uri()})
        while cls.evaluate("typeof renderSalary") != "function":
            if time.monotonic() > deadline:
                raise RuntimeError("Application did not load")
            time.sleep(0.1)

    @classmethod
    def stop_browser(cls):
        if os.name == "nt" and cls.process.poll() is None:
            # Edge runs child processes that otherwise keep the temporary profile locked.
            subprocess.run(["taskkill.exe", "/PID", str(cls.process.pid), "/T", "/F"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           creationflags=subprocess.CREATE_NO_WINDOW, timeout=10)
            cls.process.wait(timeout=5)
            return
        cls.process.terminate()
        try:
            cls.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            cls.process.kill()
            cls.process.wait(timeout=5)

    @classmethod
    def call(cls, method, params=None):
        cls.sequence += 1
        request_id = cls.sequence
        cls.ws.send(json.dumps({"id": request_id, "method": method, "params": params or {}}))
        while True:
            reply = json.loads(cls.ws.recv())
            if reply.get("id") == request_id:
                if "error" in reply:
                    raise AssertionError(reply["error"])
                return reply.get("result", {})

    @classmethod
    def evaluate(cls, expression):
        reply = cls.call("Runtime.evaluate", {"expression": expression, "returnByValue": True})
        if "exceptionDetails" in reply:
            raise AssertionError(reply["exceptionDetails"])
        return reply["result"].get("value")

    def setUp(self):
        self.evaluate("""(() => {
          const values = {'salary-gross':'30.000', 'salary-payments':'12',
            'salary-contract':'permanent', 'salary-family':'3', 'salary-children':'0',
            'salary-young-children':'0', 'salary-child-share':'0.5', 'salary-group':'4',
            'salary-territory':'common', 'salary-irpf-override':'',
            'salary-bonus':'5.000', 'salary-bonus-month':'6'};
          Object.entries(values).forEach(([id, value]) => byId(id).value = value);
          salaryExtraMonths = [6,12];
          byId('salary-bonus-enabled').checked = false;
          document.body.classList.remove('dark');
          activateMainTab('salary'); renderSalary();
        })()""")
        self.assertEqual(self.evaluate("testErrors"), [])

    def test_reference_payroll_and_extra_payments(self):
        actual = self.evaluate("calculateSalaryScenario({gross: 30000})")
        self.assertEqual(actual["socialSecurity"], 1950)
        self.assertEqual(actual["base"], 26050)
        self.assertEqual(actual["rate"], 0.1642)
        self.assertEqual(actual["tax"], 4926)
        self.assertEqual(actual["annualNet"], 23124)
        twelve = self.evaluate("buildSalaryCalendar(calculateSalaryScenario({gross:30000}), 6)")
        fourteen = self.evaluate("buildSalaryCalendar(calculateSalaryScenario({gross:30000,payments:14}), 6)")
        self.assertEqual(twelve[0]["total"], 1927)
        self.assertAlmostEqual(sum(row["total"] for row in fourteen), 23124, places=2)
        self.assertEqual(sum(row["extra"] > 0 for row in fourteen), 2)
        self.assertGreater(fourteen[5]["extra"], fourteen[5]["ordinary"])
        # Every pair of months must place exactly two extras and preserve the
        # annual net, including a bonus coinciding with an extra payment.
        failures = self.evaluate("""(() => {
          const failures=[];
          for (let first=1;first<12;first++) for (let second=first+1;second<=12;second++) {
            const r=calculateSalaryScenario({gross:34567.89,payments:14,extraMonths:[first,second],bonus:1234.56});
            const calendar=buildSalaryCalendar(r,first);
            if (JSON.stringify(calendar.filter(m=>m.extra>0).map(m=>m.month))!==JSON.stringify([first,second])
              || Math.round(calendar.reduce((sum,m)=>sum+m.total,0)*100)!==Math.round(r.annualNet*100))
              failures.push([first,second]);
          }
          return failures;
        })()""")
        self.assertEqual(failures, [])
        self.assertEqual(self.evaluate("document.querySelectorAll('#salary-extra-months .salary-month-button:disabled').length"), 12)
        self.evaluate("byId('salary-payments').value='14'; byId('salary-payments').dispatchEvent(new Event('change'));")
        annual = self.evaluate("byId('salary-annual').textContent")
        self.assertEqual(self.evaluate("Array.from(document.querySelectorAll('#salary-extra-months .salary-month-button[aria-pressed=\"true\"]')).map(b=>Number(b.dataset.month))"), [6,12])
        self.evaluate("document.querySelector('#salary-extra-months .salary-month-button[data-month=\"1\"]').click();")
        self.assertEqual(self.evaluate("salaryExtraMonths"), [6,12])
        self.evaluate("document.querySelector('#salary-extra-months .salary-month-button[data-month=\"6\"]').click();")
        self.assertTrue(self.evaluate("byId('salary-results').hidden"))
        self.evaluate("document.querySelector('#salary-extra-months .salary-month-button[data-month=\"1\"]').click(); document.querySelector('#salary-extra-months .salary-month-button[data-month=\"12\"]').click(); document.querySelector('#salary-extra-months .salary-month-button[data-month=\"7\"]').click();")
        self.assertFalse(self.evaluate("byId('salary-results').hidden"))
        self.assertEqual(self.evaluate("salaryExtraMonths"), [1,7])
        self.assertEqual(self.evaluate("byId('salary-annual').textContent"), annual)
        self.assertEqual(self.evaluate("Array.from(byId('salary-calendar-body').rows).filter(r=>r.cells[2].textContent!=='—').map(r=>r.cells[0].textContent)"), ["Enero", "Julio"])
        self.assertNotEqual(self.evaluate("byId('salary-extra').textContent"), self.evaluate("euro.format(0)"))
        self.evaluate("byId('salary-payments').value='12'; renderSalary();")
        self.assertEqual(self.evaluate("document.querySelectorAll('#salary-extra-months .salary-month-button:disabled').length"), 12)
        self.assertEqual(self.evaluate("document.querySelectorAll('#salary-extra-months .salary-month-button[aria-pressed=\"true\"]').length"), 0)
        self.assertTrue(self.evaluate("Array.from(byId('salary-calendar-body').rows).every(r=>r.cells[2].textContent==='—')"))
        self.evaluate("byId('salary-payments').value='14'; renderSalary();")
        self.assertEqual(self.evaluate("salaryExtraMonths"), [1,7])

    def test_bonus_annual_effect_and_month(self):
        fixed_monthly = self.evaluate("byId('salary-monthly').textContent")
        fixed_rate = self.evaluate("byId('salary-rate').textContent")
        self.assertEqual(self.evaluate("byId('salary-bonus-month').tagName"), "INPUT")
        self.assertEqual(self.evaluate("document.querySelectorAll('#salary-bonus-months button:disabled').length"), 12)
        self.evaluate("document.querySelector('#salary-bonus-months button[data-month=\"1\"]').click();")
        self.assertEqual(self.evaluate("byId('salary-bonus-month').value"), "6")
        self.evaluate("byId('salary-bonus-enabled').click();")
        self.assertFalse(self.evaluate("byId('salary-bonus').disabled"))
        self.assertEqual(self.evaluate("document.querySelectorAll('#salary-bonus-months button:disabled').length"), 0)
        self.assertEqual(self.evaluate("byId('salary-bonus-gain').textContent"), self.evaluate("euro.format(3272.92)"))
        self.assertEqual(self.evaluate("byId('salary-bonus-tax').textContent"), self.evaluate("`${euro.format(1402)} · ${salaryPercent(0.2804)}`"))
        self.assertEqual(self.evaluate("byId('salary-monthly').textContent"), fixed_monthly)
        self.assertEqual(self.evaluate("byId('salary-rate').textContent"), fixed_rate)
        for month in range(1, 13):
            self.evaluate(f"document.querySelector('#salary-bonus-months button[data-month=\"{month}\"]').click();")
            self.assertEqual(self.evaluate("byId('salary-bonus-month').value"), str(month))
            self.assertEqual(self.evaluate("Array.from(document.querySelectorAll('#salary-bonus-months button[aria-pressed=\"true\"]')).map(b=>Number(b.dataset.month))"), [month])
            self.assertEqual(self.evaluate("Array.from(byId('salary-calendar-body').rows).filter(r=>r.cells[3].textContent!=='—').map(r=>r.cells[0].textContent)"), [self.evaluate(f"salaryMonths[{month - 1}]")])
            rows = self.evaluate("buildSalaryCalendar(calculateSalaryScenario({gross:30000,bonus:5000}), Number(byId('salary-bonus-month').value))")
            self.assertAlmostEqual(sum(row["total"] for row in rows), 26396.92, places=2)
            self.assertEqual(next(row["month"] for row in rows if row["bonus"] > 0), month)
            self.assertEqual(rows[month - 1]["bonus"], 3272.92)
            self.assertEqual(rows[month - 1]["total"], 5199.92)
            self.assertTrue(all(row["ordinary"] == 1927 for row in rows))
            self.assertEqual(self.evaluate("byId('salary-monthly').textContent"), fixed_monthly)
        self.evaluate("byId('salary-bonus').value='invalid'; byId('salary-bonus-enabled').click();")
        self.assertFalse(self.evaluate("byId('salary-results').hidden"))
        self.assertTrue(self.evaluate("byId('salary-bonus-results').hidden"))
        self.assertTrue(self.evaluate("byId('salary-bonus').disabled"))
        self.assertEqual(self.evaluate("document.querySelectorAll('#salary-bonus-months button:disabled').length"), 12)
        self.assertEqual(self.evaluate("document.querySelectorAll('#salary-bonus-months button[aria-pressed=\"true\"]').length"), 0)
        self.evaluate("byId('salary-bonus').value='5000'; byId('salary-bonus-enabled').click(); document.querySelector('#salary-bonus-months button[data-month=\"12\"]').click();")
        self.assertEqual(self.evaluate("byId('salary-bonus-month').value"), "12")
        self.assertEqual(self.evaluate("document.querySelectorAll('#salary-bonus-months button[aria-pressed=\"true\"]').length"), 1)
        self.assertEqual(self.evaluate("salaryExtraMonths"), [6,12])

    def test_bonus_never_changes_fixed_payroll_or_extra_payments(self):
        failures = self.evaluate("""(() => {
          const failures=[];
          for (const gross of [15876, 18000, 30000, 34567.89, 80000, 350000])
          for (const payments of [12,14])
          for (const manualRate of [null,0,20,100])
          for (const bonusMonth of [1,6,12]) {
            const options={gross,payments,manualRate};
            const fixed=calculateSalaryScenario(options);
            const bonus=calculateSalaryScenario({...options,bonus:5000});
            const before=buildSalaryCalendar(fixed,bonusMonth);
            const after=buildSalaryCalendar(bonus,bonusMonth);
            if (bonus.rate!==fixed.rate || bonus.base!==fixed.base || bonus.monthlyBase!==fixed.monthlyBase
              || before.some((m,i)=>m.ordinary!==after[i].ordinary || m.extra!==after[i].extra
                || (m.month!==bonusMonth && m.total!==after[i].total))
              || Math.round((bonus.annualNet-fixed.annualNet)*100)!==Math.round(bonus.bonusNet*100))
              failures.push({gross,payments,manualRate,bonusMonth});
          }
          return failures;
        })()""")
        self.assertEqual(failures, [])
        self.evaluate("byId('salary-payments').value='14'; renderSalary();")
        before = self.evaluate("['salary-monthly','salary-extra','salary-rate','salary-bracket-caption'].map(id=>byId(id).textContent)")
        self.evaluate("byId('salary-bonus-enabled').click();")
        self.assertEqual(self.evaluate("['salary-monthly','salary-extra','salary-rate','salary-bracket-caption'].map(id=>byId(id).textContent)"), before)
        self.evaluate("byId('salary-bonus-enabled').click();")
        self.assertEqual(self.evaluate("['salary-monthly','salary-extra','salary-rate','salary-bracket-caption'].map(id=>byId(id).textContent)"), before)

    def test_manual_irpf_applies_to_bonus_separately(self):
        result = self.evaluate("calculateSalaryScenario({gross:30000,bonus:5000,manualRate:20})")
        self.assertEqual(result["rate"], 0.2)
        self.assertEqual(result["bonusTax"], 1000)
        self.assertEqual(result["bonusSocialSecurity"], 325.08)
        self.assertEqual(result["bonusNet"], 3674.92)
        self.assertEqual(result["annualNet"], 25724.92)

    def test_cents_reconcile_for_payments_bonuses_and_high_salaries(self):
        result = self.evaluate("""(() => {
          const failures=[];
          for (const gross of [1, 15876, 17094, 18000, 20000, 35200, 61214.40, 80000, 350000, 34567.89])
          for (const payments of [12,14])
          for (const bonus of [0, 1234.56])
          for (const bonusMonth of [1,6,12]) {
            const r=calculateSalaryScenario({gross,payments,bonus});
            const c=buildSalaryCalendar(r,bonusMonth);
            if (Math.round(c.reduce((s,m)=>s+m.total,0)*100)!==Math.round(r.annualNet*100)) failures.push({gross,payments,bonus,bonusMonth});
          }
          return failures;
        })()""")
        self.assertEqual(result, [])

    def test_minimum_maximum_and_solidarity(self):
        low = self.evaluate("calculateSalaryScenario({gross:15876})")
        self.assertEqual(low["monthlyBase"], 1424.4)
        self.assertEqual(low["tax"], 0)
        high = self.evaluate("calculateSalaryScenario({gross:120000})")
        self.assertEqual(high["monthlyBase"], 5101.2)
        self.assertEqual(high["contributions"][-1]["annual"], 130.68)
        group_one = self.evaluate("calculateSalaryScenario({gross:20000,group:'1'})")
        self.assertEqual(group_one["monthlyBase"], 1989.3)

    def test_family_and_short_contract(self):
        base = self.evaluate("calculateSalaryScenario({gross:30000})")
        child = self.evaluate("calculateSalaryScenario({gross:30000,children:1,youngChildren:1})")
        self.assertEqual(child["familyMinimum"], 8150)
        self.assertLess(child["tax"], base["tax"])
        single = self.evaluate("calculateSalaryScenario({gross:30000,children:1,youngChildren:1,family:'1'})")
        self.assertEqual(single["familyMinimum"], 10750)
        short = self.evaluate("calculateSalaryScenario({gross:15000,contract:'short'})")
        self.assertEqual(short["rate"], 0.02)

    def test_progressive_bracket_boundaries(self):
        self.assertEqual(self.evaluate("salaryScale(24000)"), 5365.5)
        result = self.evaluate("salaryRules.brackets.slice(0,-1).map(b => [salaryRules.brackets.findIndex(x => b.to <= x.to), salaryRules.brackets.findIndex(x => b.to + 0.01 <= x.to)])")
        self.assertEqual(result, [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]])
        self.assertEqual(self.evaluate("document.querySelectorAll('.salary-bracket.current').length"), 1)
        self.assertIn("30", self.evaluate("byId('salary-marginal').textContent"))

    def test_validation_and_foral_manual_mode(self):
        for value in ["invalid", "-20000", "Infinity", "0", "30.000,123"]:
            self.evaluate(f"byId('salary-gross').value={json.dumps(value)}; renderSalary();")
            self.assertTrue(self.evaluate("byId('salary-results').hidden"))
            self.assertTrue(self.evaluate("Boolean(byId('salary-error').textContent)"))
        self.evaluate("byId('salary-gross').value='30.000,00'; byId('salary-territory').value='manual'; renderSalary();")
        self.assertTrue(self.evaluate("byId('salary-results').hidden"))
        self.evaluate("byId('salary-irpf-override').value='20'; renderSalary();")
        self.assertFalse(self.evaluate("byId('salary-results').hidden"))
        self.assertTrue(self.evaluate("byId('salary-brackets').hidden"))
        self.assertEqual(self.evaluate("byId('salary-annual').textContent"), self.evaluate("euro.format(22050)"))
        self.evaluate("byId('salary-young-children').value='1'; renderSalary();")
        self.assertTrue(self.evaluate("byId('salary-results').hidden"))

    def test_tabs_and_mobile_dark_layout(self):
        for tab, panel in [("tab-hipotecas", "mortgage-view"), ("tab-patrimonio", "portfolio-view"), ("tab-sueldo", "salary-view")]:
            self.evaluate(f"byId('{tab}').click();")
            self.assertEqual(self.evaluate("['portfolio-view','mortgage-view','salary-view'].filter(id=>!byId(id).hidden)"), [panel])
        self.call("Emulation.setDeviceMetricsOverride", {"width": 390, "height": 844, "deviceScaleFactor": 1, "mobile": True})
        self.evaluate("document.body.classList.add('dark'); byId('salary-bonus-enabled').click(); byId('salary-payments').value='14'; renderSalary();")
        self.assertLessEqual(self.evaluate("document.documentElement.scrollWidth"), 390)
        self.assertEqual(self.evaluate("getComputedStyle(byId('salary-brackets')).gridTemplateColumns.split(' ').length"), 3)
        self.assertEqual(self.evaluate("getComputedStyle(byId('salary-extra-months')).gridTemplateColumns.split(' ').length"), 6)
        self.assertEqual(self.evaluate("getComputedStyle(byId('salary-bonus-months')).gridTemplateColumns.split(' ').length"), 6)
        mobile_screenshot = self.call("Page.captureScreenshot", {"captureBeyondViewport": True})
        (ROOT / ".data/salary-mobile-preview.png").write_bytes(base64.b64decode(mobile_screenshot["data"]))
        self.assertEqual(self.evaluate("testErrors"), [])
        self.call("Emulation.setDeviceMetricsOverride", {"width": 1365, "height": 1000, "deviceScaleFactor": 1, "mobile": False})
        self.evaluate("document.body.classList.remove('dark');")
        self.call("Runtime.evaluate", {"expression": "new Promise(resolve => setTimeout(resolve, 200))", "awaitPromise": True})
        screenshot = self.call("Page.captureScreenshot", {"captureBeyondViewport": True})
        (ROOT / ".data/salary-preview.png").write_bytes(base64.b64decode(screenshot["data"]))


if __name__ == "__main__":
    unittest.main()
