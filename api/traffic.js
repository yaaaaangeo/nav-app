export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const ITS_KEY = process.env.ITS_KEY;
  const { minX, maxX, minY, maxY } = req.query;

  try {
    const params = new URLSearchParams({
      apiKey: ITS_KEY,
      type: 'json',
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
      ok: true,
      source: 'ITS',
      traffic,
      events: [],
      updatedAt: new Date().toISOString(),
      note: '교통정보 출처: 국가교통정보센터 ITS',
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
