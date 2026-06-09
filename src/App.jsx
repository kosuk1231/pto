import React, { useState, useEffect, useMemo, useRef } from "react";
import { loadRemote, saveRemote } from "./sheetSync.js";

/* =========================================================================
   개인 휴가 · 탄력근무 관리 (2026)
   - 연차 20일 / 가족돌봄휴가 3일 / 장기근속휴가 10일 → 잔여 차감
   - 공가 / 특별휴가 → 상한 없이 누적
   - 탄력근무 → 발생(적립) / 사용(차감), 잔여 시간 관리
   - 기록은 localStorage 에 자동 저장 (기기·브라우저별 보관)
   ========================================================================= */

const STORE_KEY = "leaveData_2026_v1";
const YEAR = 2026;
const SERIF = "var(--serif)";

/* 팀 공유용 — 기본 연결 시트 없음.
   각자 앱에서 자기 스프레드시트를 연결하거나, 연결 없이 브라우저 저장으로 사용. */
const DEFAULT_SHEET_URL = "";

const C = {
  paper: "#F6F2E9", card: "#FFFFFF", ink: "#2B2620", sub: "#7A7164", line: "#E7DFCF",
  green: "#1F6B57", greenSoft: "#E5F0EC", clay: "#B5452F", claySoft: "#F4E4DE",
  gold: "#A8842C", blue: "#34607A", blueSoft: "#E3ECF1",
};

const LEAVE_TYPES = {
  annual: { key: "annual", label: "연차", capDays: 20, color: C.green, soft: C.greenSoft, capped: true },
  family: { key: "family", label: "가족돌봄휴가", capDays: 3, color: C.blue, soft: C.blueSoft, capped: true },
  longterm: { key: "longterm", label: "장기근속휴가", capDays: 10, color: C.gold, soft: "#F3ECD8", capped: true },
  comp: { key: "comp", label: "대체휴무", capDays: null, color: "#5A6E2F", soft: "#ECF0DD", capped: false },
  official: { key: "official", label: "공가", capDays: null, color: C.sub, soft: "#EFEADF", capped: false },
  special: { key: "special", label: "특별휴가", capDays: null, color: C.clay, soft: C.claySoft, capped: false },
};
const LEAVE_ORDER = ["annual", "family", "longterm", "comp", "official", "special"];

/* ---- helpers ---- */
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
const dayText = (d) => {
  if (!d) return "0";
  const full = Math.floor(d + 1e-9);
  const h = Math.round((d - full) * 8);
  const p = [];
  if (full) p.push(`${full}일`);
  if (h) p.push(`${h}시간`);
  return p.length ? p.join(" ") : "0";
};
const fmtNum = (n) => String(Math.round(n * 100) / 100);
const minToText = (m) => {
  if (!m) return "0";
  const s = m < 0 ? "-" : "", a = Math.abs(m), h = Math.floor(a / 60), mm = a % 60, p = [];
  if (h) p.push(`${h}시간`); if (mm) p.push(`${mm}분`);
  return s + (p.length ? p.join(" ") : "0");
};
const minToHM = (m) => {
  const s = m < 0 ? "-" : "", a = Math.abs(m);
  return `${s}${Math.floor(a / 60)}:${String(a % 60).padStart(2, "0")}`;
};
const timeToMin = (t) => {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  return Number.isNaN(h) || Number.isNaN(m) ? null : h * 60 + m;
};
const diffMin = (f, t) => {
  const a = timeToMin(f), b = timeToMin(t);
  return a == null || b == null ? 0 : Math.max(0, b - a);
};
const fmtDate = (iso) => {
  if (!iso) return "";
  const m = String(iso).match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${Number(m[2])}/${Number(m[3])}`;
  return ""; // 깨진 값은 빈칸 처리(저장 시 정리됨)
};
/* 어떤 형태의 날짜 문자열이 와도 ISO(yyyy-mm-dd)로 정규화.
   복구 불가능한 값(1899 등)은 빈 문자열을 돌려준다. */
const normalizeDate = (v) => {
  if (!v) return "";
  const s = String(v).replace(/^'/, "").trim();
  const m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m && m[1] !== "1899") return `${m[1]}-${String(Number(m[2])).padStart(2, "0")}-${String(Number(m[3])).padStart(2, "0")}`;
  return ""; // Sat Dec 30 1899 … → 원본 날짜 유실, 사용자가 다시 입력
};
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const sortByDate = (a, b) => {
  const x = a.date || "9999", y = b.date || "9999";
  return x < y ? -1 : x > y ? 1 : 0;
};
const normalizeData = (d) => ({
  ...defaultData(), ...d,
  caps: { ...defaultData().caps, ...(d.caps || {}) },
  profile: { ...defaultData().profile, ...(d.profile || {}) },
  leave: (d.leave || []).map((r) => ({ ...r, date: normalizeDate(r.date) })),
  flex: (d.flex || []).map((r) => ({ ...r, date: normalizeDate(r.date) })),
});

const defaultData = () => ({
  profile: { name: "", dept: "" },
  caps: { annual: 20, family: 3, longterm: 10 },
  leave: [],
  flex: [],
});

/* ---- localStorage ---- */
function loadData() {
  try {
    const v = localStorage.getItem(STORE_KEY);
    if (v) return normalizeData(JSON.parse(v));
  } catch (e) {}
  return defaultData();
}
function saveData(d) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(d)); return true; } catch (e) { return false; }
}

/* ============================ App ============================ */
export default function App() {
  const [data, setData] = useState(loadData);
  const [tab, setTab] = useState("leave");
  const [flash, setFlash] = useState(false);
  const [sheetUrl, setSheetUrl] = useState(() => {
    try {
      const stored = localStorage.getItem("sheetUrl");
      if (stored !== null) return stored;          // 사용자가 설정/해제한 값 우선
    } catch (e) {}
    return DEFAULT_SHEET_URL;                        // 최초 실행 시 기본 주소
  });
  const [sync, setSync] = useState("idle"); // idle | loading | saving | saved | error | offline
  const first = useRef(true);
  const dataRef = useRef(data);
  const urlRef = useRef(sheetUrl);
  const timer = useRef(null);
  dataRef.current = data;
  urlRef.current = sheetUrl;

  const connect = (url) => {
    const u = (url || "").trim();
    setSheetUrl(u);
    try { u ? localStorage.setItem("sheetUrl", u) : localStorage.removeItem("sheetUrl"); } catch (e) {}
  };

  /* 연결 시 스프레드시트에서 불러오기 */
  useEffect(() => {
    if (!sheetUrl) { setSync("idle"); return; }
    let alive = true;
    setSync("loading");
    loadRemote(sheetUrl)
      .then((remote) => {
        if (!alive) return;
        const n = ((remote.leave && remote.leave.length) || 0) + ((remote.flex && remote.flex.length) || 0);
        if (n > 0) {
          setData(normalizeData(remote));
          setSync("saved");
        } else {
          const local = dataRef.current;
          if (local.leave.length + local.flex.length > 0) {
            saveRemote(sheetUrl, local).then(() => alive && setSync("saved")).catch(() => alive && setSync("error"));
          } else setSync("saved");
        }
      })
      .catch(() => { if (alive) setSync("offline"); });
    return () => { alive = false; };
  }, [sheetUrl]);

  /* 변경 저장: 로컬 즉시 + 원격 디바운스 */
  useEffect(() => {
    saveData(data);
    if (first.current) { first.current = false; return; }
    setFlash(true);
    const ft = setTimeout(() => setFlash(false), 1200);
    const url = urlRef.current;
    if (url) {
      setSync("saving");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        saveRemote(url, dataRef.current).then(() => setSync("saved")).catch(() => setSync("error"));
      }, 900);
    }
    return () => clearTimeout(ft);
  }, [data]);

  const usedByType = useMemo(() => {
    const o = { annual: 0, family: 0, longterm: 0, comp: 0, official: 0, special: 0 };
    data.leave.forEach((r) => { o[r.type] = (o[r.type] || 0) + (r.days || 0); });
    return o;
  }, [data.leave]);

  // 발생(적립) 총합, 사용 총합 — 사용은 links 합으로 계산(없으면 min 폴백)
  const flexAcc = useMemo(() => data.flex.filter((f) => f.kind === "적립").reduce((s, f) => s + (f.min || 0), 0), [data.flex]);
  const usedMap = useMemo(() => {
    const m = {};
    data.flex.forEach((f) => {
      if (f.kind !== "사용") return;
      (f.links || []).forEach((l) => { m[l.id] = (m[l.id] || 0) + (l.min || 0); });
    });
    return m;
  }, [data.flex]);
  const flexUse = useMemo(
    () => data.flex.filter((f) => f.kind === "사용").reduce((s, f) => s + ((f.links ? f.links.reduce((a, l) => a + (l.min || 0), 0) : f.min) || 0), 0),
    [data.flex]
  );
  const flexBal = flexAcc - flexUse;

  const addLeave = (rec) => setData((d) => ({ ...d, leave: [...d.leave, { id: uid(), ...rec }].sort(sortByDate) }));
  const addFlex = (rec) => setData((d) => ({ ...d, flex: [...d.flex, { id: uid(), ...rec }].sort(sortByDate) }));
  const delLeave = (id) => setData((d) => ({ ...d, leave: d.leave.filter((r) => r.id !== id) }));
  const delFlex = (id) => setData((d) => ({ ...d, flex: d.flex.filter((r) => r.id !== id) }));
  const updateLeave = (id, patch) => setData((d) => ({ ...d, leave: d.leave.map((r) => (r.id === id ? { ...r, ...patch } : r)).sort(sortByDate) }));
  const updateFlex = (id, patch) => setData((d) => ({ ...d, flex: d.flex.map((r) => (r.id === id ? { ...r, ...patch } : r)).sort(sortByDate) }));

  // 가져오기: id 기준 병합(있으면 덮어쓰고, 없으면 추가)
  const importData = (incoming) => {
    const inc = normalizeData(incoming);
    setData((d) => {
      const mergeById = (cur, add) => {
        const map = new Map(cur.map((r) => [r.id, r]));
        add.forEach((r) => map.set(r.id, { ...map.get(r.id), ...r }));
        return [...map.values()].sort(sortByDate);
      };
      return {
        ...d,
        caps: { ...d.caps, ...(inc.caps || {}) },
        profile: { ...d.profile, ...(inc.profile || {}) },
        leave: mergeById(d.leave, inc.leave || []),
        flex: mergeById(d.flex, inc.flex || []),
      };
    });
  };
  const exportData = () => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `휴가탄력_백업_${todayISO()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const exportExcel = async () => {
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();

    // 1) 휴가내역
    const leaveRows = [...data.leave].sort(sortByDate).map((r) => ({
      날짜: r.date || "",
      종류: (LEAVE_TYPES[r.type] && LEAVE_TYPES[r.type].label) || r.type,
      사용: dayText(r.days),
      "일수(8h=1일)": r.days,
      비고: r.note || "",
    }));
    const wsLeave = XLSX.utils.json_to_sheet(leaveRows.length ? leaveRows : [{ 날짜: "", 종류: "", 사용: "", "일수(8h=1일)": "", 비고: "" }]);
    wsLeave["!cols"] = [{ wch: 12 }, { wch: 13 }, { wch: 12 }, { wch: 13 }, { wch: 34 }];
    XLSX.utils.book_append_sheet(wb, wsLeave, "휴가내역");

    // 2) 탄력내역 — 발생/사용을 한 시트에, 사용은 차감한 발생 사유 표기
    const earnsById = {};
    data.flex.filter((f) => f.kind === "적립").forEach((f) => (earnsById[f.id] = f));
    const flexRows = [...data.flex].sort(sortByDate).map((f) => {
      const isEarn = f.kind === "적립";
      let used = "";
      if (!isEarn) {
        const ls = f.links || [];
        used = ls.map((l) => {
          const e = earnsById[l.id];
          return `${e ? (e.reason || fmtDate(e.date)) : l.id} ${minToHM(l.min || 0)}`;
        }).join(" / ");
      }
      const total = isEarn ? f.min : (f.links ? f.links.reduce((a, l) => a + (l.min || 0), 0) : f.min);
      return {
        날짜: f.date || "",
        구분: f.kind,
        부터: f.from || "",
        까지: f.to || "",
        소요시간: minToHM(total || 0),
        분: total || 0,
        사유: f.reason || "",
        "차감한 발생": used,
      };
    });
    const wsFlex = XLSX.utils.json_to_sheet(flexRows.length ? flexRows : [{ 날짜: "", 구분: "", 부터: "", 까지: "", 소요시간: "", 분: "", 사유: "", "차감한 발생": "" }]);
    wsFlex["!cols"] = [{ wch: 12 }, { wch: 7 }, { wch: 7 }, { wch: 7 }, { wch: 9 }, { wch: 6 }, { wch: 34 }, { wch: 40 }];
    XLSX.utils.book_append_sheet(wb, wsFlex, "탄력내역");

    // 3) 요약
    const summary = [];
    LEAVE_ORDER.forEach((k) => {
      const t = LEAVE_TYPES[k];
      const used = usedByType[k] || 0;
      summary.push({
        구분: t.label,
        "총(일)": t.capped ? data.caps[k] : "-",
        "사용(일)": fmtNum(used),
        "잔여(일)": t.capped ? fmtNum(data.caps[k] - used) : "-",
      });
    });
    summary.push({ 구분: "", "총(일)": "", "사용(일)": "", "잔여(일)": "" });
    summary.push({ 구분: "탄력 적립", "총(일)": "", "사용(일)": minToHM(flexAcc), "잔여(일)": "" });
    summary.push({ 구분: "탄력 사용", "총(일)": "", "사용(일)": minToHM(flexUse), "잔여(일)": "" });
    summary.push({ 구분: "탄력 잔여", "총(일)": "", "사용(일)": "", "잔여(일)": minToHM(flexBal) });
    const wsSum = XLSX.utils.json_to_sheet(summary);
    wsSum["!cols"] = [{ wch: 14 }, { wch: 9 }, { wch: 10 }, { wch: 10 }];
    XLSX.utils.book_append_sheet(wb, wsSum, "요약");

    XLSX.writeFile(wb, `휴가탄력_내역_${todayISO()}.xlsx`);
  };
  const setProfile = (p) => setData((d) => ({ ...d, profile: { ...d.profile, ...p } }));
  const setCap = (k, v) => setData((d) => ({ ...d, caps: { ...d.caps, [k]: v } }));

  return (
    <div className="lm-wrap">
      <Header data={data} setProfile={setProfile} flash={flash} sync={sync} sheetUrl={sheetUrl} />
      <ConnectBar sheetUrl={sheetUrl} sync={sync} onConnect={connect} />

      <section className="lm-grid">
        {LEAVE_ORDER.map((k) => {
          const t = LEAVE_TYPES[k];
          return <LeaveCard key={k} t={t} used={usedByType[k] || 0} cap={t.capped ? data.caps[k] : null} setCap={(v) => setCap(k, v)} />;
        })}
        <FlexCard acc={flexAcc} use={flexUse} bal={flexBal} />
      </section>

      <nav style={{ display: "flex", gap: 6, marginTop: 26, borderBottom: `1.5px solid ${C.line}` }}>
        <TabBtn active={tab === "leave"} onClick={() => setTab("leave")}>휴가 기록</TabBtn>
        <TabBtn active={tab === "flex"} onClick={() => setTab("flex")}>탄력근무 대장</TabBtn>
      </nav>

      {tab === "leave" ? (
        <LeaveSection data={data} usedByType={usedByType} addLeave={addLeave} delLeave={delLeave} updateLeave={updateLeave} />
      ) : (
        <FlexSection data={data} addFlex={addFlex} delFlex={delFlex} bal={flexBal} usedMap={usedMap} updateFlex={updateFlex} />
      )}

      <Footer
        onReset={() => { if (confirm("모든 기록을 삭제하고 초기화할까요?")) setData(defaultData()); }}
        onImport={importData}
        onExport={exportData}
        onExportExcel={exportExcel}
      />
    </div>
  );
}

/* ============================ Header ============================ */
function Header({ data, setProfile, flash, sync, sheetUrl }) {
  return (
    <header style={{ paddingTop: 26 }}>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ display: "inline-grid", placeItems: "center", width: 30, height: 30, background: C.clay, color: "#fff", borderRadius: 7, fontFamily: SERIF, fontWeight: 700, fontSize: 15 }}>휴</span>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, letterSpacing: -0.5 }}>{YEAR} 개인 휴가·탄력 관리</h1>
          </div>
          <p style={{ margin: "8px 0 0", color: C.sub, fontSize: 13 }}>연차·가족돌봄·장기근속·공가·특별휴가 및 탄력근무 잔여를 한 곳에서.</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <EditField value={data.profile.name} placeholder="이름" onChange={(v) => setProfile({ name: v })} w={92} />
          <EditField value={data.profile.dept} placeholder="부서" onChange={(v) => setProfile({ dept: v })} w={130} />
        </div>
      </div>
      <div style={{ marginTop: 10, fontSize: 11.5, color: sheetUrl && (sync === "error" || sync === "offline") ? C.clay : sheetUrl ? C.green : C.sub, display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ width: 7, height: 7, borderRadius: 99, background: sheetUrl && (sync === "error" || sync === "offline") ? C.clay : sheetUrl ? C.green : C.sub, opacity: flash || sync === "saving" || sync === "loading" ? 1 : 0.5, transition: "opacity .3s" }} />
        {!sheetUrl ? "이 기기에만 저장됨" : sync === "loading" ? "불러오는 중…" : sync === "saving" ? "동기화 중…" : sync === "offline" ? "오프라인 — 로컬에 저장됨" : sync === "error" ? "동기화 실패 — 로컬에는 저장됨" : "스프레드시트 동기화됨"}
      </div>
    </header>
  );
}
const APPS_SCRIPT_CODE = `var SHEETS={leave:"연차",flex:"탄력",config:"설정"};
var TYPE_LABEL={annual:"연차",family:"가족돌봄휴가",longterm:"장기근속휴가",comp:"대체휴무",official:"공가",special:"특별휴가"};
var LABEL_TYPE={};Object.keys(TYPE_LABEL).forEach(function(k){LABEL_TYPE[TYPE_LABEL[k]]=k;});
function doGet(){return json(readAll());}
function doPost(e){try{var b=JSON.parse(e.postData.contents);if(b.action==="save"){writeAll(b.payload||{});return json({ok:true});}return json({ok:false,error:"unknown action"});}catch(err){return json({ok:false,error:String(err)});}}
function writeAll(p){var leave=p.leave||[],flex=p.flex||[],caps=p.caps||{},profile=p.profile||{};
var ls=sheet(SHEETS.leave);ls.clear();ls.getRange(1,1,1,6).setValues([["날짜","종류","일수","시간","비고","id"]]);
if(leave.length){var lr=ls.getRange(2,1,leave.length,6);lr.setNumberFormat("@");lr.setValues(leave.map(function(r){return [txt(r.date),TYPE_LABEL[r.type]||r.type,r.days,(r.days||0)*8,r.note||"",r.id];}));}
var fs=sheet(SHEETS.flex);fs.clear();fs.getRange(1,1,1,9).setValues([["날짜","구분","부터","까지","소요시간","사유","분","id","차감정보"]]);
if(flex.length){var fr=fs.getRange(2,1,flex.length,9);fr.setNumberFormat("@");fr.setValues(flex.map(function(r){var mins=r.min||0;if(r.kind==="사용"&&r.links&&r.links.length){mins=r.links.reduce(function(a,l){return a+(l.min||0);},0);}return [txt(r.date),r.kind,txt(r.from||""),txt(r.to||""),txt(hm(mins)),r.reason||"",mins,r.id,r.links?JSON.stringify(r.links):""];}));}
var cs=sheet(SHEETS.config);cs.clear();cs.getRange(1,1,6,2).setValues([["항목","값"],["이름",profile.name||""],["부서",profile.dept||""],["연차_총일수",caps.annual!=null?caps.annual:20],["가족돌봄_총일수",caps.family!=null?caps.family:3],["장기근속_총일수",caps.longterm!=null?caps.longterm:10]]);}
function readAll(){var out={leave:[],flex:[],caps:{annual:20,family:3,longterm:10},profile:{name:"",dept:""}};
var ls=SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.leave);if(ls){var lv=ls.getDataRange().getValues();for(var i=1;i<lv.length;i++){var r=lv[i];if(!r[0])continue;out.leave.push({id:String(r[5]||"L"+i),date:fmtDate(r[0]),type:LABEL_TYPE[r[1]]||r[1],days:Number(r[2])||0,note:String(r[4]||"")});}}
var fs=SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.flex);if(fs){var fv=fs.getDataRange().getValues();for(var j=1;j<fv.length;j++){var f=fv[j];if(f[0]===""&&f[5]==="")continue;var rec={id:String(f[7]||"F"+j),date:fmtDate(f[0]),kind:String(f[1]||"적립"),from:fmtTime(f[2]),to:fmtTime(f[3]),min:Number(f[6])||0,reason:String(f[5]||"")};if(f[8]){try{rec.links=JSON.parse(f[8]);}catch(e){}}out.flex.push(rec);}}
var cs=SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.config);if(cs){var cv=cs.getDataRange().getValues(),map={};for(var k=1;k<cv.length;k++)map[cv[k][0]]=cv[k][1];out.profile.name=String(map["이름"]||"");out.profile.dept=String(map["부서"]||"");if(map["연차_총일수"]!=null&&map["연차_총일수"]!=="")out.caps.annual=Number(map["연차_총일수"]);if(map["가족돌봄_총일수"]!=null&&map["가족돌봄_총일수"]!=="")out.caps.family=Number(map["가족돌봄_총일수"]);if(map["장기근속_총일수"]!=null&&map["장기근속_총일수"]!=="")out.caps.longterm=Number(map["장기근속_총일수"]);}
return out;}
function sheet(name){var s=SpreadsheetApp.getActiveSpreadsheet();return s.getSheetByName(name)||s.insertSheet(name);}
function json(o){return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);}
function hm(n){var a=Math.abs(n),h=Math.floor(a/60),m=a%60;return (n<0?"-":"")+h+":"+("0"+m).slice(-2);}
function txt(v){return v==null||v===""?"":"'"+String(v);}
function fmtDate(v){if(v instanceof Date)return Utilities.formatDate(v,Session.getScriptTimeZone(),"yyyy-MM-dd");var s=String(v==null?"":v).replace(/^'/,"").trim();var m=s.match(/(\\d{4})-(\\d{1,2})-(\\d{1,2})/);if(m)return m[1]+"-"+("0"+m[2]).slice(-2)+"-"+("0"+m[3]).slice(-2);return s;}
function fmtTime(v){if(v instanceof Date)return Utilities.formatDate(v,Session.getScriptTimeZone(),"HH:mm");var s=String(v==null?"":v).replace(/^'/,"").trim();var m=s.match(/(\\d{1,2}):(\\d{2})/);if(m)return ("0"+m[1]).slice(-2)+":"+m[2];return "";}`;

function ConnectBar({ sheetUrl, sync, onConnect }) {
  const [open, setOpen] = useState(false);
  const [guide, setGuide] = useState(false);
  const [draft, setDraft] = useState(sheetUrl);
  const [copied, setCopied] = useState(false);
  useEffect(() => setDraft(sheetUrl), [sheetUrl]);
  const connected = !!sheetUrl;

  const copyCode = async () => {
    try { await navigator.clipboard.writeText(APPS_SCRIPT_CODE); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch (e) { alert("복사 실패 — 코드를 길게 눌러 직접 복사하세요."); }
  };

  return (
    <div style={{ marginTop: 10 }}>
      <button onClick={() => setOpen((o) => !o)} style={{ background: connected ? C.greenSoft : "#F2EDE2", color: connected ? C.green : C.sub, border: "none", padding: "6px 12px", borderRadius: 99, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
        {connected ? "☁ 내 스프레드시트 연동됨" : "＋ 내 스프레드시트에 저장하기 (선택)"} {open ? "▴" : "▾"}
      </button>
      {open && (
        <div style={{ ...panel, marginTop: 8 }}>
          {!connected && (
            <p style={{ margin: "0 0 10px", fontSize: 12, color: C.sub, lineHeight: 1.6 }}>
              연결하지 않아도 <b style={{ color: C.ink }}>이 기기 브라우저</b>에 모든 기록이 저장됩니다. 휴대폰·PC에서 함께 보거나 백업하고 싶을 때만 <b style={{ color: C.ink }}>내 Google 스프레드시트</b>를 연결하세요. (각자 자기 시트를 쓰므로 팀원 간 기록은 섞이지 않습니다.)
            </p>
          )}

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="https://script.google.com/macros/s/.../exec" style={{ ...selStyle, flex: "1 1 260px", minWidth: 0 }} />
            <button onClick={() => onConnect(draft)} style={addBtn}>연결</button>
            {connected && <button onClick={() => onConnect("")} style={{ ...fchip, padding: "9px 14px" }}>연결 해제</button>}
          </div>

          <button onClick={() => setGuide((g) => !g)} style={{ marginTop: 10, background: "none", border: "none", color: C.green, cursor: "pointer", fontSize: 12, fontWeight: 600, padding: 0 }}>
            {guide ? "▾ 내 시트 만드는 방법 닫기" : "▸ 내 시트 만드는 방법 (처음이라면)"}
          </button>

          {guide && (
            <ol style={{ margin: "10px 0 0", paddingLeft: 18, fontSize: 12, color: C.ink, lineHeight: 1.75 }}>
              <li>내 Google 드라이브에서 <b>새 스프레드시트</b>를 만든다 (빈 문서).</li>
              <li>상단 메뉴 <b>확장 프로그램 → Apps Script</b> 클릭.</li>
              <li>
                기존 코드를 모두 지우고 아래 코드를 붙여넣는다.
                <div style={{ margin: "6px 0", display: "flex", gap: 6, alignItems: "center" }}>
                  <button onClick={copyCode} style={{ ...addBtn, background: copied ? C.green : C.ink, padding: "6px 12px", fontSize: 12 }}>{copied ? "복사됨 ✓" : "설치 코드 복사"}</button>
                  <span style={{ fontSize: 11, color: C.sub }}>← 누르고 Apps Script 편집기에 붙여넣기</span>
                </div>
              </li>
              <li>저장(💾) 후 우측 상단 <b>배포 → 새 배포</b>.</li>
              <li>유형 <b>웹 앱</b> 선택 → 실행: <b>나</b>, 액세스: <b>모든 사용자</b> (꼭!).</li>
              <li>배포하면 나오는 <b>…/exec</b> 주소를 복사해 위 칸에 붙여넣고 <b>연결</b>.</li>
            </ol>
          )}

          <p style={{ margin: "10px 0 0", fontSize: 11, color: C.sub }}>
            {connected
              ? "다른 기기에서 같은 주소로 연결하면 기록이 공유됩니다. 인터넷이 끊겨도 이 기기에는 계속 저장됩니다."
              : "액세스를 ‘모든 사용자’로 하지 않으면 연결 시 ‘동기화 실패’가 뜹니다."}
          </p>
        </div>
      )}
    </div>
  );
}

function EditField({ value, placeholder, onChange, w }) {
  return (
    <input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)}
      style={{ width: w, maxWidth: "42vw", padding: "7px 10px", border: `1px solid ${C.line}`, borderRadius: 8, background: C.card, fontSize: 13, color: C.ink, outline: "none" }} />
  );
}

/* ============================ Cards ============================ */
function LeaveCard({ t, used, cap, setCap }) {
  if (t.capped) {
    const remain = cap - used;
    const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
    return (
      <div style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
          <span style={{ fontSize: 12.5, fontWeight: 700, color: t.color }}>{t.label}</span>
          <CapEdit value={cap} onChange={setCap} />
        </div>
        <div style={{ marginTop: 10, display: "flex", alignItems: "baseline", gap: 4 }}>
          <span style={{ fontFamily: SERIF, fontSize: 29, fontWeight: 700, lineHeight: 1, color: remain < 0 ? C.clay : C.ink }}>{fmtNum(remain)}</span>
          <span style={{ fontSize: 12, color: C.sub }}>일 남음</span>
        </div>
        <div style={{ fontSize: 11, color: C.sub, marginTop: 4 }}>= {dayText(remain)} · 사용 {fmtNum(used)}일 / 총 {cap}일</div>
        <div style={{ height: 6, background: t.soft, borderRadius: 99, marginTop: 9, overflow: "hidden" }}>
          <div style={{ width: `${pct}%`, height: "100%", background: t.color, transition: "width .4s" }} />
        </div>
      </div>
    );
  }
  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: t.color }}>{t.label}</span>
        <span style={{ fontSize: 10.5, color: C.sub, background: t.soft, padding: "2px 7px", borderRadius: 99 }}>발생 시</span>
      </div>
      <div style={{ marginTop: 10, display: "flex", alignItems: "baseline", gap: 4 }}>
        <span style={{ fontFamily: SERIF, fontSize: 29, fontWeight: 700, lineHeight: 1 }}>{fmtNum(used)}</span>
        <span style={{ fontSize: 12, color: C.sub }}>일 사용</span>
      </div>
      <div style={{ fontSize: 11, color: C.sub, marginTop: 4 }}>누적 {dayText(used)}</div>
      <div style={{ height: 6, background: t.soft, borderRadius: 99, marginTop: 9 }} />
    </div>
  );
}
function FlexCard({ acc, use, bal }) {
  return (
    <div style={{ ...cardStyle, background: bal >= 0 ? "#13312A" : "#3a1410", color: "#fff", borderColor: "transparent" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: "#9FD6C4" }}>탄력근무</span>
        <span style={{ fontSize: 10.5, color: "#cfe9e0", background: "rgba(255,255,255,.1)", padding: "2px 7px", borderRadius: 99 }}>적립−사용</span>
      </div>
      <div style={{ marginTop: 10, display: "flex", alignItems: "baseline", gap: 5 }}>
        <span style={{ fontFamily: SERIF, fontSize: 29, fontWeight: 700, lineHeight: 1 }}>{minToHM(bal)}</span>
        <span style={{ fontSize: 12, color: "#cfe9e0" }}>잔여</span>
      </div>
      <div style={{ fontSize: 11, color: "#bcd9cf", marginTop: 4 }}>= {minToText(bal)}</div>
      <div style={{ display: "flex", gap: 14, marginTop: 9, fontSize: 11 }}>
        <span style={{ color: "#9FD6C4" }}>적립 {minToHM(acc)}</span>
        <span style={{ color: "#e6b3a6" }}>사용 {minToHM(use)}</span>
      </div>
    </div>
  );
}
function CapEdit({ value, onChange }) {
  const [edit, setEdit] = useState(false);
  if (edit)
    return (
      <input type="number" autoFocus value={value} min={0}
        onChange={(e) => onChange(Number(e.target.value))}
        onBlur={() => setEdit(false)}
        onKeyDown={(e) => e.key === "Enter" && setEdit(false)}
        style={{ width: 52, padding: "1px 5px", border: `1px solid ${C.line}`, borderRadius: 6, fontSize: 12, textAlign: "right" }} />
    );
  return (
    <button onClick={() => setEdit(true)} title="총 일수 수정" style={{ fontSize: 10.5, color: C.sub, background: "#F2EDE2", border: "none", padding: "3px 7px", borderRadius: 99, cursor: "pointer" }}>총 {value}일 ✎</button>
  );
}
const cardStyle = { background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: "14px 15px", boxShadow: "0 1px 2px rgba(43,38,32,.04)" };

/* ============================ 휴가 섹션 ============================ */
function LeaveSection({ data, usedByType, addLeave, delLeave, updateLeave }) {
  const [type, setType] = useState("annual");
  const [date, setDate] = useState(todayISO());
  const [days, setDays] = useState(0.25);
  const [customH, setCustomH] = useState("");
  const [note, setNote] = useState("");
  const [filter, setFilter] = useState("all");
  const capped = LEAVE_TYPES[type].capped;

  const submit = () => {
    let d = days;
    if (customH !== "" && !Number.isNaN(Number(customH))) d = capped ? Number(customH) / 8 : Number(customH);
    if (!date || !d || d <= 0) return;
    addLeave({ type, date, days: Math.round(d * 100) / 100, note: note.trim() });
    setNote(""); setCustomH("");
  };
  const rows = data.leave.filter((r) => filter === "all" || r.type === filter);

  return (
    <div>
      <div style={{ ...panel, marginTop: 18 }}>
        <div className="lm-form">
          <Field label="종류">
            <select value={type} onChange={(e) => { setType(e.target.value); setCustomH(""); }} style={selStyle}>
              {LEAVE_ORDER.map((k) => <option key={k} value={k}>{LEAVE_TYPES[k].label}</option>)}
            </select>
          </Field>
          <Field label="날짜"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={selStyle} /></Field>
          {capped ? (
            <>
              <Field label="사용량">
                <div className="lm-chiprow" style={{ display: "flex", gap: 5 }}>
                  {[["2시간", 0.25], ["4시간", 0.5], ["종일", 1]].map(([lab, v]) => (
                    <button key={v} onClick={() => { setDays(v); setCustomH(""); }} style={{ ...chip, ...(customH === "" && days === v ? chipOn : {}) }}>{lab}</button>
                  ))}
                </div>
              </Field>
              <Field label="직접(시간)"><input type="number" step="1" min="0" placeholder="예: 6" value={customH} onChange={(e) => setCustomH(e.target.value)} style={{ ...selStyle, width: 96 }} /></Field>
            </>
          ) : (
            <Field label="일수"><input type="number" step="0.5" min="0" placeholder="예: 4 (4일)" value={customH} onChange={(e) => setCustomH(e.target.value)} style={{ ...selStyle, width: 110 }} /></Field>
          )}
          <Field label="비고 / 사유" grow><input value={note} onChange={(e) => setNote(e.target.value)} placeholder={capped ? "(선택)" : "예: 배우자 출산휴가"} style={{ ...selStyle, width: "100%" }} /></Field>
          <button className="lm-add" onClick={submit} style={addBtn}>＋ 기록</button>
        </div>
        <p style={{ margin: "10px 2px 0", fontSize: 11, color: C.sub }}>
          {capped ? "버튼은 2/4/8시간(종일=8h=1일). 그 외 시간은 ‘직접(시간)’에 입력." : "공가·특별휴가는 상한 없이 누적됩니다. 일수로 입력하세요(예: 4일)."}
        </p>
      </div>

      <div style={{ display: "flex", gap: 6, marginTop: 16, flexWrap: "wrap" }}>
        <button onClick={() => setFilter("all")} style={{ ...fchip, ...(filter === "all" ? fchipOn : {}) }}>전체 {data.leave.length}</button>
        {LEAVE_ORDER.map((k) => (
          <button key={k} onClick={() => setFilter(k)} style={{ ...fchip, ...(filter === k ? { ...fchipOn, background: LEAVE_TYPES[k].color } : {}) }}>
            {LEAVE_TYPES[k].label} {fmtNum(usedByType[k] || 0)}일
          </button>
        ))}
      </div>

      <div style={{ marginTop: 12 }}>
        {rows.length === 0 ? <Empty>아직 기록이 없습니다. 위에서 휴가를 추가해 보세요.</Empty> : (
          <div style={listWrap}>
            {[...rows].reverse().map((r) => {
              const t = LEAVE_TYPES[r.type];
              return (
                <div key={r.id} className="lm-row">
                  <DateCell value={r.date} onChange={(v) => updateLeave(r.id, { date: v })} />
                  <span style={{ fontSize: 11, fontWeight: 700, color: t.color, background: t.soft, padding: "3px 9px", borderRadius: 99, textAlign: "center", whiteSpace: "nowrap" }}>{t.label}</span>
                  <span style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 14, minWidth: 78 }}>{dayText(r.days)}</span>
                  <TextCell value={r.note} onChange={(v) => updateLeave(r.id, { note: v })} placeholder="비고 입력" />
                  <button onClick={() => delLeave(r.id)} style={delBtn}>✕</button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================ 탄력 섹션 ============================ */
function FlexSection({ data, addFlex, delFlex, bal, usedMap, updateFlex }) {
  const [kind, setKind] = useState("적립");
  const [date, setDate] = useState(todayISO());
  const [reason, setReason] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const autoMin = diffMin(from, to);

  // 사용 모드: 선택한 발생들과 사용 시간
  const [selected, setSelected] = useState([]); // 발생 id 배열(선택 순서 유지)
  const [useMin, setUseMin] = useState(""); // 분, 비우면 선택 잔여 전부
  const reasonTouched = useRef(false); // 사용자가 사유칸을 직접 고쳤는지

  // 발생별 잔여(분)
  const remainOf = (f) => (f.min || 0) - (usedMap[f.id] || 0);
  const earns = [...data.flex].filter((f) => f.kind === "적립").sort(sortByDate);
  const openEarns = earns.filter((f) => remainOf(f) > 0);

  const selectedRemain = selected.reduce((s, id) => {
    const f = earns.find((e) => e.id === id);
    return s + (f ? remainOf(f) : 0);
  }, 0);

  // 선택한 발생들의 사유를 합쳐 문자열로
  const reasonFromIds = (ids) => {
    const names = ids
      .map((id) => earns.find((e) => e.id === id))
      .filter(Boolean)
      .map((e) => e.reason || fmtDate(e.date) || "발생");
    return [...new Set(names)].join(", ");
  };

  const toggleSel = (id) =>
    setSelected((cur) => {
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      // 사용자가 직접 고치지 않았다면 선택 사유를 자동으로 채움
      if (!reasonTouched.current) setReason(reasonFromIds(next));
      return next;
    });

  // 사용자가 사유칸을 직접 입력하면 자동채움 중단
  const onReasonEdit = (v) => { reasonTouched.current = true; setReason(v); };

  const submitEarn = () => {
    if (!date || autoMin <= 0) return;
    addFlex({ kind: "적립", date, reason: reason.trim(), from, to, min: autoMin });
    setReason(""); setFrom(""); setTo("");
  };

  const submitUse = () => {
    if (!date || selected.length === 0) return;
    let want = useMin === "" ? selectedRemain : Math.round(Number(useMin) || 0);
    if (want <= 0) return;
    want = Math.min(want, selectedRemain); // 잔여 초과 방지
    // 선택 순서대로 차감
    const links = [];
    let left = want;
    for (const id of selected) {
      if (left <= 0) break;
      const f = earns.find((e) => e.id === id);
      if (!f) continue;
      const take = Math.min(remainOf(f), left);
      if (take > 0) { links.push({ id, min: take }); left -= take; }
    }
    if (links.length === 0) return;
    // 사유를 비우면 차감한 발생들의 사유로 자동 생성
    let rsn = reason.trim();
    if (!rsn) {
      const names = links
        .map((l) => earns.find((e) => e.id === l.id))
        .filter(Boolean)
        .map((e) => e.reason || fmtDate(e.date) || "발생");
      const uniq = [...new Set(names)];
      rsn = uniq.length ? uniq.join(", ") + " 차감" : "탄력 사용";
    }
    addFlex({ kind: "사용", date, reason: rsn, links, min: want - left });
    setReason(""); setSelected([]); setUseMin(""); reasonTouched.current = false;
  };

  // ── 발생↔사용 매칭 데이터 ──
  const usesByEarn = {};      // earnId → [{use, min}]
  const orphanUses = [];      // 어느 발생에도 연결 안 된 사용(레거시)
  data.flex.filter((f) => f.kind === "사용").forEach((u) => {
    const ls = u.links || [];
    if (ls.length === 0) { orphanUses.push(u); return; }
    ls.forEach((l) => {
      if (!usesByEarn[l.id]) usesByEarn[l.id] = [];
      usesByEarn[l.id].push({ use: u, min: l.min || 0 });
    });
  });
  // 발생 목록(최신순), 잔여 있는 것 먼저
  const earnsDesc = [...earns].sort((a, b) => sortByDate(b, a));
  const openList = earnsDesc.filter((f) => remainOf(f) > 0);
  const doneList = earnsDesc.filter((f) => remainOf(f) <= 0);

  return (
    <div>
      <div style={{ ...panel, marginTop: 18 }}>
        <div className="lm-form">
          <Field label="구분">
            <div className="lm-chiprow" style={{ display: "flex", gap: 5 }}>
              {["적립", "사용"].map((k) => (
                <button key={k} onClick={() => { setKind(k); setReason(""); setSelected([]); reasonTouched.current = false; }} style={{ ...chip, ...(kind === k ? { ...chipOn, background: k === "적립" ? C.green : C.clay } : {}) }}>
                  {k === "적립" ? "＋ 발생" : "－ 사용"}
                </button>
              ))}
            </div>
          </Field>
          <Field label={kind === "적립" ? "발생일" : "사용일"}><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={selStyle} /></Field>

          {kind === "적립" ? (
            <>
              <Field label="부터"><input type="time" value={from} onChange={(e) => setFrom(e.target.value)} step="600" style={{ ...selStyle, width: 120 }} /></Field>
              <Field label="까지"><input type="time" value={to} onChange={(e) => setTo(e.target.value)} step="600" style={{ ...selStyle, width: 120 }} /></Field>
              <Field label="소요시간"><div className="lm-fill" style={{ ...selStyle, minWidth: 64, fontFamily: SERIF, fontWeight: 700, color: autoMin > 0 ? C.ink : C.sub, background: "#F7F3EA" }}>{autoMin > 0 ? minToHM(autoMin) : "0:00"}</div></Field>
              <Field label="사유" grow><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="예: 회장단 회의 / 권익옹호위원회 정기회의" style={{ ...selStyle, width: "100%" }} /></Field>
              <button className="lm-add" onClick={submitEarn} style={{ ...addBtn, background: C.green }}>＋ 등록</button>
            </>
          ) : (
            <>
              <Field label="사용시간">
                <input type="number" step="30" min="0" placeholder={selectedRemain ? `전부(${minToHM(selectedRemain)})` : "분"} value={useMin} onChange={(e) => setUseMin(e.target.value)} style={{ ...selStyle, width: 130 }} />
              </Field>
              <Field label="사유" grow>
                <div style={{ display: "flex", gap: 6 }}>
                  <input value={reason} onChange={(e) => onReasonEdit(e.target.value)} placeholder="발생 선택 시 자동 입력 (직접 수정 가능)" style={{ ...selStyle, width: "100%" }} />
                  {reasonTouched.current && selected.length > 0 && (
                    <button onClick={() => { reasonTouched.current = false; setReason(reasonFromIds(selected)); }} title="선택 사유로 되돌리기" style={{ ...fchip, padding: "0 11px", whiteSpace: "nowrap" }}>↺ 자동</button>
                  )}
                </div>
              </Field>
              <button className="lm-add" onClick={submitUse} style={{ ...addBtn, background: C.clay, opacity: selected.length ? 1 : 0.5 }}>－ 정산</button>
            </>
          )}
        </div>

        {kind === "적립" ? (
          <p style={{ margin: "10px 2px 0", fontSize: 11, color: C.sub }}>
            현재 잔여 <b style={{ color: bal >= 0 ? C.green : C.clay }}>{minToHM(bal)}</b> ({minToText(bal)}). 회의·촬영 등 초과근무는 ‘발생’으로 적립합니다.
          </p>
        ) : (
          <UsePicker openEarns={openEarns} remainOf={remainOf} selected={selected} toggleSel={toggleSel} selectedRemain={selectedRemain} useMin={useMin} />
        )}
      </div>

      <div style={{ marginTop: 16 }}>
        {earns.length === 0 && orphanUses.length === 0 ? (
          <Empty>탄력근무 기록이 없습니다. ‘발생’으로 적립부터 해보세요.</Empty>
        ) : (
          <>
            {/* 헤더 */}
            <div className="lm-matchhead" style={{ display: "flex", gap: 10, padding: "0 4px 8px", fontSize: 11, color: C.sub, fontWeight: 700 }}>
              <span style={{ flex: "0 0 auto", width: "46%" }}>발생 (적립)</span>
              <span style={{ flex: 1 }}>→ 사용 내역</span>
            </div>

            {/* 잔여 있는 발생 */}
            {openList.map((f) => (
              <EarnRow key={f.id} f={f} remain={remainOf(f)} uses={usesByEarn[f.id] || []} updateFlex={updateFlex} delFlex={delFlex} defaultOpen />
            ))}

            {/* 완료(잔여 0) 발생 — 접어두기 */}
            {doneList.length > 0 && (
              <DoneFold count={doneList.length}>
                {doneList.map((f) => (
                  <EarnRow key={f.id} f={f} remain={remainOf(f)} uses={usesByEarn[f.id] || []} updateFlex={updateFlex} delFlex={delFlex} />
                ))}
              </DoneFold>
            )}

            {/* 미연결 사용(레거시) */}
            {orphanUses.length > 0 && (
              <div style={{ ...listWrap, marginTop: 12, borderColor: C.claySoft }}>
                <div style={{ padding: "8px 14px", fontSize: 11, fontWeight: 700, color: C.clay, background: C.claySoft }}>발생과 연결되지 않은 사용 {orphanUses.length}건 (예전 방식 기록)</div>
                {[...orphanUses].sort((a, b) => sortByDate(b, a)).map((u) => (
                  <div key={u.id} className="lm-row">
                    <DateCell value={u.date} onChange={(v) => updateFlex(u.id, { date: v })} />
                    <span style={{ minWidth: 44, fontSize: 11, fontWeight: 700, color: C.clay }}>－사용</span>
                    <span style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 13, minWidth: 52 }}>{minToHM(u.min)}</span>
                    <TextCell value={u.reason} onChange={(v) => updateFlex(u.id, { reason: v })} placeholder="사유 입력" />
                    <button onClick={() => delFlex(u.id)} style={delBtn}>✕</button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* 발생 1건 + 그 발생에서 차감해 간 사용들을 좌우로 */
function EarnRow({ f, remain, uses, updateFlex, delFlex, defaultOpen }) {
  const done = remain <= 0;
  const usedSum = uses.reduce((s, u) => s + u.min, 0);
  return (
    <div style={{ ...listWrap, marginBottom: 10, opacity: done ? 0.7 : 1 }}>
      <div className="lm-match" style={{ display: "flex", gap: 0, alignItems: "stretch" }}>
        {/* 왼쪽: 발생 */}
        <div className="lm-match-l" style={{ flex: "0 0 auto", width: "46%", padding: "12px 14px", borderRight: `1px solid ${C.line}`, background: "#FBFAF6" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 10.5, fontWeight: 700, color: C.green, background: C.greenSoft, padding: "2px 7px", borderRadius: 99 }}>＋적립</span>
            <DateCell value={f.date} onChange={(v) => updateFlex(f.id, { date: v })} />
            <span style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 15, color: C.ink }}>{minToHM(f.min)}</span>
            {f.from && <span className="lm-hidemob" style={{ fontSize: 10.5, color: C.sub }}>{f.from}~{f.to}</span>}
            <button onClick={() => delFlex(f.id)} style={{ ...delBtn, marginLeft: "auto" }}>✕</button>
          </div>
          <div style={{ marginTop: 5 }}>
            <TextCell value={f.reason} onChange={(v) => updateFlex(f.id, { reason: v })} placeholder="사유 입력" />
          </div>
          <div style={{ marginTop: 7, display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, color: C.sub }}>사용 {minToHM(usedSum)}</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: done ? C.sub : C.green }}>
              {done ? "✓ 소진" : `잔여 ${minToHM(remain)}`}
            </span>
          </div>
        </div>

        {/* 오른쪽: 사용들 */}
        <div className="lm-match-r" style={{ flex: 1, padding: "8px 12px", display: "flex", flexDirection: "column", gap: 6, justifyContent: uses.length ? "flex-start" : "center" }}>
          {uses.length === 0 ? (
            <span style={{ fontSize: 12, color: C.sub }}>아직 사용 없음</span>
          ) : (
            [...uses].sort((a, b) => sortByDate(b.use, a.use)).map(({ use, min }, i) => (
              <div key={use.id + i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
                <span style={{ fontSize: 10.5, fontWeight: 700, color: C.clay, background: C.claySoft, padding: "2px 6px", borderRadius: 99, whiteSpace: "nowrap" }}>－{minToHM(min)}</span>
                <span style={{ fontFamily: SERIF, fontSize: 13, color: C.sub, minWidth: 36 }}>{fmtDate(use.date)}</span>
                <span style={{ color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{use.reason || "(사유 없음)"}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/* 완료된 발생 접기/펼치기 */
function DoneFold({ count, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 4 }}>
      <button onClick={() => setOpen((o) => !o)} style={{ width: "100%", textAlign: "left", background: "#F2EDE2", color: C.sub, border: "none", padding: "9px 14px", borderRadius: 10, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
        {open ? "▾" : "▸"} 소진 완료된 발생 {count}건 {open ? "접기" : "펼치기"}
      </button>
      {open && <div style={{ marginTop: 10 }}>{children}</div>}
    </div>
  );
}

function UsePicker({ openEarns, remainOf, selected, toggleSel, selectedRemain, useMin }) {
  const want = useMin === "" ? selectedRemain : Math.min(Math.round(Number(useMin) || 0), selectedRemain);
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 11.5, color: C.sub, marginBottom: 7 }}>
        차감할 <b style={{ color: C.green }}>발생 내역</b>을 선택하세요(여러 개 가능, 선택 순서대로 차감).
        {selected.length > 0 && <> 선택 잔여 <b style={{ color: C.ink }}>{minToHM(selectedRemain)}</b> · 정산 <b style={{ color: C.clay }}>{minToHM(want)}</b></>}
      </div>
      {openEarns.length === 0 ? (
        <div style={{ fontSize: 12.5, color: C.sub, padding: "10px 0" }}>차감할 수 있는 발생 잔여가 없습니다. 먼저 ‘발생’으로 적립하세요.</div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
          {openEarns.map((f) => {
            const on = selected.includes(f.id);
            return (
              <button key={f.id} onClick={() => toggleSel(f.id)} style={{
                textAlign: "left", border: `1.5px solid ${on ? C.green : C.line}`, background: on ? C.greenSoft : C.card,
                borderRadius: 10, padding: "8px 11px", cursor: "pointer", maxWidth: 230,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ width: 15, height: 15, borderRadius: 5, border: `1.5px solid ${on ? C.green : C.line}`, background: on ? C.green : "#fff", color: "#fff", fontSize: 10, display: "grid", placeItems: "center", flexShrink: 0 }}>{on ? "✓" : ""}</span>
                  <span style={{ fontFamily: SERIF, fontSize: 13, color: C.sub }}>{fmtDate(f.date)}</span>
                  <span style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 13, color: C.green }}>잔여 {minToHM(remainOf(f))}</span>
                </div>
                <div style={{ fontSize: 11.5, color: C.sub, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.reason || "(사유 없음)"}</div>
              </button>
            );
          })}
        </div>
      )}
      <p style={{ margin: "9px 2px 0", fontSize: 11, color: C.sub }}>
        사용시간을 비우면 선택한 발생의 잔여 전부를 차감합니다. 값을 넣으면 그만큼만 선택 순서대로 차감합니다.
      </p>
    </div>
  );
}

/* 사유 등 텍스트 셀 — 클릭하면 편집 */
function TextCell({ value, onChange, placeholder }) {
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState(value || "");
  useEffect(() => setV(value || ""), [value]);
  if (edit)
    return (
      <input
        autoFocus value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => { setEdit(false); onChange(v.trim()); }}
        onKeyDown={(e) => { if (e.key === "Enter") { setEdit(false); onChange(v.trim()); } }}
        placeholder={placeholder}
        className="lm-note"
        style={{ fontSize: 12.5, padding: "3px 6px", border: `1px solid ${C.line}`, borderRadius: 7, fontFamily: "var(--sans)", outline: "none" }}
      />
    );
  const empty = !value;
  return (
    <span className="lm-note" onClick={() => setEdit(true)} title="사유 수정"
      style={{ fontSize: 12.5, color: empty ? C.clay : C.sub, cursor: "pointer", borderBottom: `1px dotted ${empty ? C.clay : "transparent"}` }}>
      {value || placeholder || "사유 입력"}
    </span>
  );
}

/* 일자 셀 — 클릭하면 날짜 편집. 빈 날짜는 ‘날짜 입력’으로 강조 */
function DateCell({ value, onChange }) {
  const [edit, setEdit] = useState(false);
  if (edit)
    return (
      <input
        type="date" autoFocus value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => setEdit(false)}
        onKeyDown={(e) => e.key === "Enter" && setEdit(false)}
        style={{ width: 138, padding: "3px 6px", border: `1px solid ${C.line}`, borderRadius: 7, fontSize: 13 }}
      />
    );
  const has = !!fmtDate(value);
  return (
    <button onClick={() => setEdit(true)} title="날짜 수정"
      style={{ fontFamily: SERIF, fontSize: 14, minWidth: 46, textAlign: "left", border: has ? "none" : `1px dashed ${C.clay}`, background: has ? "transparent" : C.claySoft, color: has ? C.sub : C.clay, cursor: "pointer", padding: has ? 0 : "2px 6px", borderRadius: 6 }}>
      {has ? fmtDate(value) : "날짜입력"}
    </button>
  );
}

/* ============================ 작은 컴포넌트 ============================ */
function Field({ label, children, grow }) {
  return (
    <label className="lm-field" style={{ display: "flex", flexDirection: "column", gap: 5, flex: grow ? "1 1 200px" : "0 0 auto", minWidth: 0 }}>
      <span style={{ fontSize: 11, color: C.sub, fontWeight: 600 }}>{label}</span>
      {children}
    </label>
  );
}
function TabBtn({ active, children, onClick }) {
  return (
    <button onClick={onClick} style={{ padding: "10px 16px", border: "none", background: "transparent", cursor: "pointer", fontSize: 14, fontWeight: active ? 800 : 600, color: active ? C.ink : C.sub, borderBottom: `2.5px solid ${active ? C.clay : "transparent"}`, marginBottom: -1.5 }}>{children}</button>
  );
}
function Empty({ children }) {
  return <div style={{ ...panel, textAlign: "center", color: C.sub, fontSize: 13, padding: "30px 16px" }}>{children}</div>;
}
function Footer({ onReset, onImport, onExport, onExportExcel }) {
  const fileRef = useRef(null);
  const pick = () => fileRef.current && fileRef.current.click();
  const [busy, setBusy] = useState(false);
  const onFile = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const r = new FileReader();
    r.onload = () => {
      try { onImport(JSON.parse(r.result)); alert("가져오기 완료. 기존 기록과 병합되었습니다."); }
      catch (err) { alert("파일을 읽을 수 없습니다(JSON 형식 확인)."); }
    };
    r.readAsText(file);
    e.target.value = "";
  };
  const doExcel = async () => {
    setBusy(true);
    try { await onExportExcel(); } catch (e) { alert("엑셀 내보내기에 실패했습니다."); }
    setBusy(false);
  };
  const btn = { background: "none", border: `1px solid ${C.line}`, color: C.sub, padding: "5px 11px", borderRadius: 8, cursor: "pointer", fontSize: 11.5, fontFamily: "var(--sans)" };
  return (
    <div style={{ marginTop: 30, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, fontSize: 11.5, color: C.sub, flexWrap: "wrap" }}>
      <span>8시간 = 1일 · 탄력근무 10분 단위</span>
      <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
        <input ref={fileRef} type="file" accept="application/json,.json" onChange={onFile} style={{ display: "none" }} />
        <button onClick={pick} style={btn}>가져오기(JSON)</button>
        <button onClick={doExcel} disabled={busy} style={{ ...btn, color: C.green, borderColor: "#CDE0D7", opacity: busy ? 0.6 : 1 }}>{busy ? "내보내는 중…" : "엑셀 내보내기"}</button>
        <button onClick={onExport} style={btn}>백업(JSON)</button>
        <button onClick={onReset} style={{ ...btn, color: C.clay, borderColor: C.claySoft }}>전체 초기화</button>
      </div>
    </div>
  );
}

/* ============================ 스타일 ============================ */
const panel = { background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: 16, boxShadow: "0 1px 2px rgba(43,38,32,.04)" };
const selStyle = { padding: "8px 10px", border: `1px solid ${C.line}`, borderRadius: 9, background: C.card, fontSize: 14, color: C.ink, outline: "none" };
const chip = { padding: "8px 11px", border: `1px solid ${C.line}`, borderRadius: 9, background: C.card, fontSize: 13, color: C.sub, cursor: "pointer", fontWeight: 600 };
const chipOn = { background: C.green, color: "#fff", borderColor: "transparent" };
const addBtn = { padding: "9px 16px", border: "none", borderRadius: 9, background: C.clay, color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" };
const fchip = { padding: "6px 11px", border: `1px solid ${C.line}`, borderRadius: 99, background: C.card, fontSize: 12, color: C.sub, cursor: "pointer", fontWeight: 600 };
const fchipOn = { background: C.ink, color: "#fff", borderColor: "transparent" };
const listWrap = { border: `1px solid ${C.line}`, borderRadius: 12, overflow: "hidden", background: C.card };
const delBtn = { width: 24, height: 24, borderRadius: 7, border: "none", background: "#F2EDE2", color: C.sub, cursor: "pointer", fontSize: 12, flexShrink: 0 };
