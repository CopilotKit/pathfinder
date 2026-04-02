import { createServer } from "node:http";

const PORT = 1234;

const CANNED_WEATHER = {
  location: null,
  current: {
    temperature_c: 22.5,
    temperature_f: 72.5,
    humidity: 58,
    wind_speed_kmh: 14.3,
    wind_direction: "NW",
    condition: "Partly cloudy",
    uv_index: 5,
    feels_like_c: 21.8,
    feels_like_f: 71.2,
    visibility_km: 10,
  },
  forecast: [
    { date: "2026-04-03", high_c: 24, low_c: 15, condition: "Sunny" },
    { date: "2026-04-04", high_c: 21, low_c: 13, condition: "Rain showers" },
    { date: "2026-04-05", high_c: 19, low_c: 12, condition: "Overcast" },
  ],
  units: { temperature: "celsius", wind_speed: "km/h", visibility: "km" },
};

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/get-weather") {
    const location = url.searchParams.get("location");
    if (!location) {
      return json(res, 400, { error: "Missing required parameter: location" });
    }
    return json(res, 200, { ...CANNED_WEATHER, location });
  }

  json(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`Breeze API fixture server running at http://localhost:${PORT}`);
});
