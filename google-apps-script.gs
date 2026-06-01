/*** ────────────────────────────────────────────────────────────────
 *  개인 휴가·탄력 관리 — Google 스프레드시트 백엔드 (Apps Script)
 *
 *  [설치 방법]
 *  1) Google 스프레드시트를 새로 만든다(빈 시트여도 됨).
 *  2) 확장 프로그램 → Apps Script 클릭.
 *  3) 기본 코드를 지우고 이 파일 전체를 붙여넣고 저장한다.
 *  4) 우측 상단 "배포 → 새 배포" → 유형 "웹 앱".
 *       - 실행 권한: 나
 *       - 액세스 권한: "모든 사용자"  (※ 반드시 이걸로)
 *  5) 배포하면 나오는  https://script.google.com/macros/s/............/exec
 *     URL을 복사해 앱의 "스프레드시트 연동"에 붙여넣는다.
 *
 *  연차/탄력/설정 세 시트가 자동으로 만들어지고, 사람이 읽을 수 있는
 *  형태로 기록이 저장된다. (앱이 저장할 때마다 시트를 다시 씀)
 *  ──────────────────────────────────────────────────────────────── */

var SHEETS = { leave: "연차", flex: "탄력", config: "설정" };
var TYPE_LABEL = { annual: "연차", family: "가족돌봄휴가", longterm: "장기근속휴가", official: "공가", special: "특별휴가" };
var LABEL_TYPE = {};
Object.keys(TYPE_LABEL).forEach(function (k) { LABEL_TYPE[TYPE_LABEL[k]] = k; });

function doGet() {
  return json(readAll());
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.action === "save") {
      writeAll(body.payload || {});
      return json({ ok: true });
    }
    return json({ ok: false, error: "알 수 없는 action" });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

/* ---- 쓰기 ---- */
function writeAll(p) {
  var leave = p.leave || [], flex = p.flex || [], caps = p.caps || {}, profile = p.profile || {};

  var ls = sheet(SHEETS.leave);
  ls.clearContents();
  ls.getRange(1, 1, 1, 6).setValues([["날짜", "종류", "일수", "시간", "비고", "id"]]);
  if (leave.length) {
    ls.getRange(2, 1, leave.length, 6).setValues(leave.map(function (r) {
      return [r.date, TYPE_LABEL[r.type] || r.type, r.days, (r.days || 0) * 8, r.note || "", r.id];
    }));
  }

  var fs = sheet(SHEETS.flex);
  fs.clearContents();
  fs.getRange(1, 1, 1, 8).setValues([["날짜", "구분", "부터", "까지", "소요시간", "사유", "분", "id"]]);
  if (flex.length) {
    fs.getRange(2, 1, flex.length, 8).setValues(flex.map(function (r) {
      return [r.date, r.kind, r.from || "", r.to || "", hm(r.min || 0), r.reason || "", r.min || 0, r.id];
    }));
  }

  var cs = sheet(SHEETS.config);
  cs.clearContents();
  cs.getRange(1, 1, 6, 2).setValues([
    ["항목", "값"],
    ["이름", profile.name || ""],
    ["부서", profile.dept || ""],
    ["연차_총일수", caps.annual != null ? caps.annual : 20],
    ["가족돌봄_총일수", caps.family != null ? caps.family : 3],
    ["장기근속_총일수", caps.longterm != null ? caps.longterm : 10],
  ]);
}

/* ---- 읽기 ---- */
function readAll() {
  var out = { leave: [], flex: [], caps: { annual: 20, family: 3, longterm: 10 }, profile: { name: "", dept: "" } };

  var ls = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.leave);
  if (ls) {
    var lv = ls.getDataRange().getValues();
    for (var i = 1; i < lv.length; i++) {
      var r = lv[i];
      if (!r[0]) continue;
      out.leave.push({ id: String(r[5] || "L" + i), date: fmtDate(r[0]), type: LABEL_TYPE[r[1]] || r[1], days: Number(r[2]) || 0, note: String(r[4] || "") });
    }
  }

  var fs = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.flex);
  if (fs) {
    var fv = fs.getDataRange().getValues();
    for (var j = 1; j < fv.length; j++) {
      var f = fv[j];
      if (!f[0]) continue;
      out.flex.push({ id: String(f[7] || "F" + j), date: fmtDate(f[0]), kind: String(f[1] || "적립"), from: fmtTime(f[2]), to: fmtTime(f[3]), min: Number(f[6]) || 0, reason: String(f[5] || "") });
    }
  }

  var cs = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.config);
  if (cs) {
    var cv = cs.getDataRange().getValues(), map = {};
    for (var k = 1; k < cv.length; k++) map[cv[k][0]] = cv[k][1];
    out.profile.name = String(map["이름"] || "");
    out.profile.dept = String(map["부서"] || "");
    if (map["연차_총일수"] != null && map["연차_총일수"] !== "") out.caps.annual = Number(map["연차_총일수"]);
    if (map["가족돌봄_총일수"] != null && map["가족돌봄_총일수"] !== "") out.caps.family = Number(map["가족돌봄_총일수"]);
    if (map["장기근속_총일수"] != null && map["장기근속_총일수"] !== "") out.caps.longterm = Number(map["장기근속_총일수"]);
  }
  return out;
}

/* ---- 유틸 ---- */
function sheet(name) {
  var s = SpreadsheetApp.getActiveSpreadsheet();
  return s.getSheetByName(name) || s.insertSheet(name);
}
function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function hm(n) {
  var a = Math.abs(n), h = Math.floor(a / 60), m = a % 60;
  return (n < 0 ? "-" : "") + h + ":" + ("0" + m).slice(-2);
}
function fmtDate(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy-MM-dd");
  return String(v || "");
}
function fmtTime(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), "HH:mm");
  return String(v || "");
}
