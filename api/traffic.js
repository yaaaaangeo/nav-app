export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const ITS_KEY = process.env.ITS_KEY;
  const { minX, maxX, minY, maxY } = req.query;

  const url = `https://openapi.its.go.kr:9443/trafficInfo?apiKey=${ITS_KEY}&type=all&getType=json&minX=${minX}&maxX=${maxX}&minY=${minY}&maxY=${maxY}`;

  console.log('Fetching:', url.replace(ITS_KEY, '***'));

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const r = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' }
    });
    clearTimeout(timeout);

    console.log('Response status:', r.status);
    const text = await r.text();
    console.log('Response preview:', text.slice(0, 200));

    const json = JSON.parse(text);

    if (json?.header?.resultCode !== 0) {
      throw new Error(json?.header?.resultMsg || 'ITS 오류');
    }

    const rows = json?.body?.items || [];
    const list = Array.isArray(rows) ? rows : [rows];
    const traffic = list.map(item => ({
      roadName:   item.roadName || '',
      linkId:     item.linkId || '',
      speed:      Number(item.speed) || 0,
      travelTime: Number(item.travelTime) || 0,
    }));

    return res.json({
      ok: true, source: 'ITS', traffic, events: [],
      updatedAt: new Date().toISOString(),
      note: '교통정보 출처: 국가교통정보센터 ITS',
    });

  } catch (e) {
    console.error('Error name:', e.name);
    console.error('Error message:', e.message);
    console.error('Error cause:', e.cause);
    return res.status(500).json({
      ok: false,
      error: e.message,
      errorName: e.name,
      errorCause: String(e.cause || ''),
    });
  }
}
