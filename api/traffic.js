export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const TOPIS_KEY = process.env.TOPIS_KEY;
  const ITS_KEY   = process.env.ITS_KEY;

  const { loc, minX, maxX, minY, maxY, linkIds } = req.query;

  try {
    if (loc === '강남') {
      // linkIds: 쉼표로 구분된 링크 ID 목록
      const ids = (linkIds || '').split(',').map(s => s.trim()).filter(Boolean);

      if (ids.length === 0) {
        return res.json({
          ok: true, source: 'TOPIS', traffic: [], events: [],
          updatedAt: new Date().toISOString(),
          note: '링크 ID가 없습니다. 구간 설정을 확인해주세요.',
        });
      }

      // 링크 ID별로 XML 조회 후 파싱
      const traffic = [];
      await Promise.all(ids.map(async (linkId) => {
        try {
          const url = `http://openapi.seoul.go.kr:8088/${TOPIS_KEY}/xml/TrafficInfo/1/1/${linkId}`;
          const r = await fetch(url);
          const text = await r.text();

          // XML 파싱: <prcs_spd>, <link_id>
          const speedMatch = text.match(/<prcs_spd>(\d+\.?\d*)<\/prcs_spd>/);
          const speed = speedMatch ? Number(speedMatch[1]) : 0;

          traffic.push({
            roadName: linkId,
            linkId,
            speed,
            roadType: 'urban',
          });
        } catch(e) {
          // 개별 링크 실패는 무시
        }
      }));

      return res.json({
        ok: true, source: 'TOPIS', traffic, events: [],
        updatedAt: new Date().toISOString(),
        note: '교통정보 출처: 서울특별시 TOPIS (공공누리 1유형)',
      });

    } else {
      // 국가 ITS - 영역 기반 조회
      const params = new URLSearchParams({
        apiKey: ITS_KEY, type: 'json',
        minX, maxX, minY, maxY,
      });
      const url = `https://openapi.its.go.kr:9443/trafficInfo?${params}`;
      const r = await fetch(url);
      const json = await r.json();
      const rows = json?.body?.items?.item || [];
      const list = Array.isArray(rows) ? rows : [rows];
      const traffic = list.map(r => ({
        roadName: r.roadName || r.linkName || '',
        speed:    Number(r.speed) || 0,
        roadType: r.roadsTypeCode === '1' ? '고속도로' : 'urban',
      }));
      return res.json({
        ok: true, source: 'ITS', traffic, events: [],
        updatedAt: new Date().toISOString(),
        note: '교통정보 출처: 국가교통정보센터 ITS',
      });
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
