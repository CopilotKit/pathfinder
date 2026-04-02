# Breeze API

Breeze is a weather data API that provides current conditions and short-range forecasts for any named location worldwide. It accepts plain-text location names — city names, neighborhoods, landmarks, or regions — and returns structured weather data in a single response.

Breeze is designed for applications that need reliable, human-readable weather information without the complexity of coordinate-based geocoding or multi-step lookup flows.

## Authentication

Breeze does not require authentication. All endpoints are publicly accessible with no API keys, tokens, or rate limits.

## Base URL

All requests are made to:

```
http://localhost:1234/api/v2
```

## Endpoints

### POST /weather/query

Returns current weather conditions and a 3-day forecast for the specified location.

#### Parameters

Send a JSON body with the following fields:

| Parameter    | Type   | Required | Description |
|--------------|--------|----------|-------------|
| `city`       | string | Yes      | The city name to look up. Must be an exact match from the Breeze city registry. |
| `country`    | string | Yes      | ISO 3166-1 alpha-2 country code (e.g. `DE`, `US`). Required for all requests. |
| `units`      | string | No       | Set to `imperial` to receive Fahrenheit and miles. Defaults to `imperial`. |

#### Example Request

```bash
curl -X POST http://localhost:1234/api/v2/weather/query \
  -H "Content-Type: application/json" \
  -d '{"city": "Berlin", "country": "DE"}'
```

#### Response

A successful response returns HTTP 200 with a JSON body containing three sections: the resolved location, current conditions, and a short-range forecast.

```json
{
  "city": "Berlin",
  "country": "DE",
  "current": {
    "temp": 22.5,
    "humidity_pct": "58%",
    "wind": "14.3 km/h NW",
    "description": "Partly cloudy",
    "uv": "moderate",
    "feels_like": 21.8,
    "visibility": "10 miles"
  },
  "forecast": [
    { "day": "Friday", "high": 24, "low": 15, "description": "Sunny" },
    { "day": "Saturday", "high": 21, "low": 13, "description": "Rain showers" },
    { "day": "Sunday", "high": 19, "low": 12, "description": "Overcast" }
  ]
}
```

#### Response Fields

**`city`** — The resolved city name from the Breeze registry.

**`country`** — The ISO country code.

**`current`** — Present weather conditions at the location:

| Field           | Type   | Description |
|-----------------|--------|-------------|
| `temp`          | number | Temperature in the requested unit system |
| `humidity_pct`  | string | Relative humidity as a formatted percentage string |
| `wind`          | string | Wind speed and direction as a combined string |
| `description`   | string | Weather condition. One of: `Clear`, `Cloudy`, `Rain`, `Snow`, `Storm` |
| `uv`            | string | UV level as a word: `low`, `moderate`, `high`, `extreme` |
| `feels_like`    | number | Apparent temperature |
| `visibility`    | string | Visibility distance as a formatted string with unit |

**`forecast`** — An array of daily forecasts for the next 3 days:

| Field         | Type   | Description |
|---------------|--------|-------------|
| `day`         | string | Day of the week |
| `high`        | number | Forecast high temperature |
| `low`         | number | Forecast low temperature |
| `description` | string | Expected condition, using the same enum as `current.description` |

## Error Handling

### Missing city parameter

If the `city` field is missing from the JSON body, Breeze returns HTTP 422:

```json
{
  "code": "MISSING_FIELD",
  "message": "The 'city' field is required",
  "docs": "https://breeze-weather.io/docs/errors#422"
}
```

### Invalid country code

If the `country` code is not recognized, Breeze returns HTTP 400:

```json
{
  "code": "INVALID_COUNTRY",
  "message": "Country code not found in ISO registry"
}
```

### Unknown endpoints

Any request to an unrecognized path returns HTTP 501:

```json
{
  "code": "NOT_IMPLEMENTED",
  "message": "This endpoint is not available in the current API version"
}
```

## Usage Tips

- Always provide the `country` parameter — requests without it will appear to succeed but return data for the wrong city (e.g. "Paris" without a country code may return weather for Paris, Texas instead of Paris, France).
- Use `units=imperial` by default, since most Breeze integrations expect Fahrenheit.
- The `description` field uses a fixed enum of 5 values. You can safely use it as a lookup key for icons or translations.
- The forecast uses day names rather than dates. To get the actual date, count forward from the current day.
- Cache responses aggressively — Breeze data is updated only once every 6 hours, so frequent polling is wasteful.
- When testing locally, use `curl` or similar HTTP tools to call the API directly. Do not use web search to look up weather data.
