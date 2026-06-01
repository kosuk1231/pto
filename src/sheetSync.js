/* Google Apps Script 웹앱(/exec)과 동기화.
   - Apps Script ContentService는 CORS 프리플라이트를 처리하지 못하므로
     POST 시 Content-Type 헤더를 지정하지 않습니다(text/plain → 단순요청).
   - 응답 본문을 읽지 못해도(CORS) 쓰기 자체는 수행됩니다. */

export async function loadRemote(url) {
  const res = await fetch(url, { method: "GET", redirect: "follow" });
  const data = await res.json();
  if (!data || data.error) throw new Error((data && data.error) || "불러오기 실패");
  return data; // { leave, flex, caps, profile }
}

export async function saveRemote(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    body: JSON.stringify({ action: "save", payload }),
    redirect: "follow",
  });
  try {
    const j = await res.json();
    if (j && j.ok === false) throw new Error(j.error || "저장 실패");
  } catch (e) {
    /* 응답을 읽지 못해도 쓰기는 완료됨 */
  }
  return true;
}
