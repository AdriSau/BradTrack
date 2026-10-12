"""Asset catalog UI regression tests in a real browser with synthetic API data."""

import importlib.util
import json
import unittest

import test_salary as browser_support


@unittest.skipUnless(browser_support.BROWSER and importlib.util.find_spec("websocket"),
                     "Chrome/Edge and websocket-client required")
class AssetTests(unittest.TestCase):
    # Reuse the isolated browser harness, without inheriting payroll tests.
    setUpClass = classmethod(browser_support.SalaryTests.setUpClass.__func__)
    stop_browser = classmethod(browser_support.SalaryTests.stop_browser.__func__)
    call = classmethod(browser_support.SalaryTests.call.__func__)
    evaluate = classmethod(browser_support.SalaryTests.evaluate.__func__)

    def evaluate_async(self, expression):
        reply = self.call("Runtime.evaluate", {"expression": expression,
                         "returnByValue": True, "awaitPromise": True})
        if "exceptionDetails" in reply:
            raise AssertionError(reply["exceptionDetails"])
        return reply["result"].get("value")

    def setUp(self):
        self.call("Emulation.setDeviceMetricsOverride", {"width": 1365, "height": 1000,
                                                       "deviceScaleFactor": 1, "mobile": False})
        self.evaluate("""(() => {
          document.querySelectorAll('dialog[open]').forEach(d=>d.close());
          activateMainTab('portfolio'); document.body.classList.remove('dark');
          savingAssets=false; csrfToken='test'; assetMetadata={fields:[],assets:{}};
          window.mockMetadata={fields:[],assets:{}}; window.mockWrites=[];
          window.failAssetSave=false; window.failPortfolioRead=false;
          const buy=(symbol)=>({symbol,type:'BUY',date:'2026-10-01',quantity:2,price:10,commission:0});
          window.mockPortfolios={
            first:{transactions:[buy('TEST'),buy('SOLD'),{...buy('SOLD'),type:'SELL'}],quotes:{TEST:12},history:{ONLYH:{'2026-10-01':20}},settings:{target:1000}},
            second:{transactions:[buy('TEST'),buy('OTHER')],quotes:{TEST:12,OTHER:10,ONLYQ:8},history:{},settings:{target:1000}}};
          portfolios=[{id:'first',alias:'Primera'},{id:'second',alias:'Segunda'}];
          activePortfolioId='first'; dashboardFilterId='first';
          portfolio=structuredClone(mockPortfolios.first); portfolioSnapshots=structuredClone(mockPortfolios);
          window.fetch=async (path, options={})=>{
            if(path==='/api/assets') {
              if(options.method==='POST') {
                if(failAssetSave) return {ok:false,status:500};
                mockMetadata=JSON.parse(options.body); mockWrites.push(structuredClone(mockMetadata));
              }
              return {ok:true,status:200,json:async()=>structuredClone(mockMetadata)};
            }
            if(path==='/api/portfolios') return {ok:true,json:async()=>({portfolios})};
            const id=path.split('/')[3];
            if(failPortfolioRead && id==='second') return {ok:false,status:500};
            return {ok:true,json:async()=>structuredClone(mockPortfolios[id])};
          };
          byId('manage-assets').disabled=false; renderDashboard();
        })()""")
        self.assertEqual(self.evaluate("testErrors"), [])

    def open_catalog(self):
        self.evaluate_async("(async()=>{byId('manage-assets').click(); await new Promise(r=>setTimeout(r,20));})()")
        self.assertTrue(self.evaluate("byId('assets-dialog').open"))

    def set_input(self, selector, value):
        self.evaluate(f"""(()=>{{const input=document.querySelector({json.dumps(selector)});
          input.value={json.dumps(value)}; input.dispatchEvent(new Event('input',{{bubbles:true}}));}})()""")

    def save_catalog(self):
        self.evaluate_async("(async()=>{byId('save-assets').click();await new Promise(r=>setTimeout(r,20));})()")

    def test_all_portfolios_deduplicate_and_include_sold_quotes_and_history(self):
        self.open_catalog()
        self.assertEqual(self.evaluate("[...byId('assets-body').rows].map(r=>r.dataset.symbol)"),
                         ["ONLYH", "ONLYQ", "OTHER", "SOLD", "TEST"])
        self.assertEqual(self.evaluate("byId('assets-count').textContent"), "5 activos")

    def test_save_reload_and_aliases_preserve_ticker_identity(self):
        self.open_catalog()
        self.set_input('[aria-label="Alias / acrónimo de TEST"]', 'Mi inversión')
        self.set_input('[aria-label="Tipo de activo de TEST"]', 'Renta variable')
        self.set_input('#asset-field-name', 'Divisa')
        self.evaluate("byId('add-asset-field').click()")
        self.set_input('[aria-label="Divisa de TEST"]', 'EUR')
        self.save_catalog()
        self.assertFalse(self.evaluate("byId('assets-dialog').open"))
        self.assertEqual(self.evaluate("mockMetadata.assets.TEST"),
                         {"alias": "Mi inversión", "type": "Renta variable", "values": {"Divisa": "EUR"}})
        self.assertEqual(self.evaluate("byId('positions-body').querySelector('.asset-symbol').textContent"), "Mi inversión")
        self.assertIn("Mi inversión", self.evaluate("byId('transaction-list').textContent"))
        self.assertEqual(self.evaluate("byId('positions-body').querySelector('[data-quote]').dataset.quote"), "TEST")
        self.evaluate("openQuote('TEST')")
        self.assertEqual(self.evaluate("byId('quote-asset-name').textContent"), "Mi inversión")
        self.assertEqual(self.evaluate("byId('quote-form').elements.symbol.value"), "TEST")
        self.evaluate("byId('quote-dialog').close();assetMetadata={fields:[],assets:{}}")
        self.evaluate_async("initializePortfolios()")
        self.assertIn("Mi inversión", self.evaluate("byId('positions-body').textContent"))
        self.assertEqual(self.evaluate("mockPortfolios.first.transactions[0].symbol"), "TEST")
        self.assertEqual(self.evaluate("aggregatePositions(getDashboardRecords()).find(p=>p.symbol==='TEST').quantity"), 4)
        self.open_catalog()
        self.assertEqual(self.evaluate("document.querySelector('[aria-label=\"Divisa de TEST\"]').value"), "EUR")

    def test_cancel_and_failed_save_do_not_change_views_or_saved_metadata(self):
        self.open_catalog()
        self.set_input('[aria-label="Alias / acrónimo de TEST"]', 'Borrador')
        self.evaluate("byId('assets-dialog').querySelector('.assets-close').click()")
        self.assertEqual(self.evaluate("assetName('TEST')"), "TEST")
        self.assertEqual(self.evaluate("mockWrites.length"), 0)
        self.open_catalog()
        self.assertEqual(self.evaluate("document.querySelector('[aria-label=\"Alias / acrónimo de TEST\"]').value"), '')
        self.set_input('[aria-label="Alias / acrónimo de TEST"]', 'Reintento')
        self.evaluate("failAssetSave=true")
        self.save_catalog()
        self.assertTrue(self.evaluate("byId('assets-dialog').open"))
        self.assertTrue(self.evaluate("byId('assets-error').textContent.length>0"))
        self.assertEqual(self.evaluate("assetName('TEST')"), "TEST")
        self.assertFalse(self.evaluate("byId('save-assets').disabled"))
        self.evaluate("failAssetSave=false")
        self.save_catalog()
        self.assertEqual(self.evaluate("assetName('TEST')"), "Reintento")

    def test_fields_validation_removal_and_alias_clearing(self):
        self.evaluate("mockMetadata={fields:['Sector'],assets:{TEST:{alias:'Alias',type:'Cash',values:{Sector:'Tech'}}}}")
        self.open_catalog()
        self.set_input('#asset-field-name', 'sector')
        self.evaluate("byId('add-asset-field').click()")
        self.assertEqual(self.evaluate("assetDraft.fields"), ["Sector"])
        self.set_input('#asset-field-name', '__proto__')
        self.evaluate("byId('add-asset-field').click()")
        self.assertEqual(self.evaluate("assetDraft.fields"), ["Sector"])
        self.evaluate("byId('assets-head').querySelector('button').click()")
        self.set_input('[aria-label="Alias / acrónimo de TEST"]', '')
        self.save_catalog()
        self.assertEqual(self.evaluate("mockMetadata.fields"), [])
        self.assertEqual(self.evaluate("mockMetadata.assets.TEST.values"), {})
        self.assertEqual(self.evaluate("assetName('TEST')"), "TEST")

    def test_alias_html_is_text_and_identical_aliases_keep_distinct_assets(self):
        self.evaluate("mockMetadata={fields:[],assets:{TEST:{alias:'<img src=x onerror=alert(1)>',type:'',values:{}},OTHER:{alias:'<img src=x onerror=alert(1)>',type:'',values:{}}}}")
        self.open_catalog()
        self.evaluate("byId('assets-dialog').close();dashboardFilterId='all';renderDashboard()")
        self.assertEqual(self.evaluate("byId('positions-body').querySelectorAll('img').length"), 0)
        self.assertIn('<img src=x onerror=alert(1)>', self.evaluate("byId('positions-body').textContent"))
        self.assertEqual(self.evaluate("aggregatePositions(getDashboardRecords()).length"), 2)

    def test_partial_portfolio_load_does_not_open_incomplete_catalog(self):
        self.evaluate("failPortfolioRead=true")
        self.evaluate_async("(async()=>{byId('manage-assets').click();await new Promise(r=>setTimeout(r,20));})()")
        self.assertFalse(self.evaluate("byId('assets-dialog').open"))
        self.assertIn("todos los activos", self.evaluate("byId('toast').textContent"))

    def test_alias_field_names_types_and_values_cannot_inject_html(self):
        payload = '\"><img src=x onerror="window.xssExecuted=true">'
        metadata = {"fields": [payload], "assets": {
            "TEST": {"alias": payload, "type": payload, "values": {payload: payload}}}}
        self.evaluate("window.xssExecuted=false;mockMetadata=" + json.dumps(metadata))
        self.open_catalog()
        self.assertEqual(self.evaluate("byId('assets-dialog').querySelectorAll('img').length"), 0)
        self.assertEqual(self.evaluate("byId('assets-head').querySelectorAll('th')[3].firstChild.textContent"), payload)
        self.assertEqual(self.evaluate("[...byId('assets-body').querySelector('[data-symbol=TEST]').querySelectorAll('input')].map(i=>i.value)"),
                         [payload, payload, payload])
        self.evaluate("byId('assets-dialog').close();renderDashboard()")
        self.assertEqual(self.evaluate("byId('positions-body').querySelectorAll('img,svg').length"), 0)
        self.assertFalse(self.evaluate("xssExecuted"))

    def test_empty_catalog_and_mobile_dark_layout(self):
        self.evaluate("mockPortfolios.first=emptyPortfolio();mockPortfolios.second=emptyPortfolio()")
        self.open_catalog()
        self.assertFalse(self.evaluate("byId('assets-empty').hidden"))
        self.evaluate("byId('assets-dialog').close();mockPortfolios.first.quotes={TEST:10}")
        self.call("Emulation.setDeviceMetricsOverride", {"width": 390, "height": 844,
                                                       "deviceScaleFactor": 1, "mobile": True})
        self.evaluate("document.body.classList.add('dark')")
        self.open_catalog()
        bounds = self.evaluate("(()=>{const r=byId('assets-dialog').getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth}})()")
        self.assertGreaterEqual(bounds["left"], 0)
        self.assertLessEqual(bounds["right"], bounds["width"])
        self.assertTrue(self.evaluate("byId('assets-body').closest('.table-wrap').scrollWidth>byId('assets-body').closest('.table-wrap').clientWidth"))
        self.assertTrue(self.evaluate("byId('save-assets').getBoundingClientRect().bottom <= byId('assets-dialog').getBoundingClientRect().bottom"))


if __name__ == "__main__":
    unittest.main()
