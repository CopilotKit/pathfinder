# Breeze API

Breeze is a weather data API that provides current conditions and short-range forecasts for any named location worldwide. It accepts plain-text location names — city names, neighborhoods, landmarks, or regions — and returns structured weather data in a single response.

Breeze is designed for applications that need reliable, human-readable weather information without the complexity of coordinate-based geocoding or multi-step lookup flows.

## Authentication

Breeze does not require authentication. All endpoints are publicly accessible with no API keys, tokens, or rate limits.

## Base URL

All requests are made to:

```
http://localhost:1234
```

## Endpoints

### GET /get-weather

Returns current weather conditions and a 3-day forecast for the specified location.

#### Parameters

| Parameter  | Type   | Required | Description |
|------------|--------|----------|-------------|
| `location` | string | Yes      | A human-readable location name. Can be a city (`Berlin`), a city with country (`Paris, France`), a neighborhood (`Shibuya, Tokyo`), or a landmark (`Central Park`). |

#### Example Request

```
GET /get-weather?location=Berlin
```

#### Response

A successful response returns HTTP 200 with a JSON body containing three sections: the resolved location, current conditions, and a short-range forecast.

```json
{
  "location": "Berlin",
  "current": {
    "temperature_c": 22.5,
    "temperature_f": 72.5,
    "humidity": 58,
    "wind_speed_kmh": 14.3,
    "wind_direction": "NW",
    "condition": "Partly cloudy",
    "uv_index": 5,
    "feels_like_c": 21.8,
    "feels_like_f": 71.2,
    "visibility_km": 10
  },
  "forecast": [
    { "date": "2026-04-03", "high_c": 24, "low_c": 15, "condition": "Sunny" },
    { "date": "2026-04-04", "high_c": 21, "low_c": 13, "condition": "Rain showers" },
    { "date": "2026-04-05", "high_c": 19, "low_c": 12, "condition": "Overcast" }
  ],
  "units": {
    "temperature": "celsius",
    "wind_speed": "km/h",
    "visibility": "km"
  }
}
```

#### Response Fields

**`location`** — The location string exactly as provided in the request.

**`current`** — Present weather conditions at the location:

| Field             | Type   | Description |
|-------------------|--------|-------------|
| `temperature_c`   | number | Temperature in Celsius |
| `temperature_f`   | number | Temperature in Fahrenheit |
| `humidity`         | number | Relative humidity as a percentage (0–100) |
| `wind_speed_kmh`  | number | Wind speed in kilometers per hour |
| `wind_direction`   | string | Cardinal or intercardinal wind direction (e.g. `NW`, `SSE`) |
| `condition`        | string | Human-readable weather condition (e.g. `Partly cloudy`, `Rain showers`, `Clear sky`) |
| `uv_index`         | number | UV index on a scale of 0–11+ |
| `feels_like_c`     | number | Apparent temperature in Celsius, accounting for wind chill and humidity |
| `feels_like_f`     | number | Apparent temperature in Fahrenheit |
| `visibility_km`    | number | Horizontal visibility in kilometers |

**`forecast`** — An array of daily forecasts for the next 3 days:

| Field       | Type   | Description |
|-------------|--------|-------------|
| `date`      | string | Date in `YYYY-MM-DD` format |
| `high_c`    | number | Forecast high temperature in Celsius |
| `low_c`     | number | Forecast low temperature in Celsius |
| `condition` | string | Expected weather condition for the day |

**`units`** — Describes the measurement units used in the response. Breeze always returns metric units.

## Error Handling

### Missing location parameter

If the `location` query parameter is omitted, Breeze returns HTTP 400:

```json
{
  "error": "Missing required parameter: location"
}
```

### Unknown endpoints

Any request to a path other than `/get-weather` returns HTTP 404:

```json
{
  "error": "Not found"
}
```

### HTTP methods

Only `GET` requests are supported. Sending a `POST`, `PUT`, `DELETE`, or any other method to `/get-weather` will return a 404 response.

## Usage Tips

- Location matching is flexible. Both `"New York"` and `"New York, USA"` are valid inputs.
- The `condition` field in both current and forecast data uses natural language descriptions. There is no enum — conditions are descriptive strings like `Sunny`, `Partly cloudy`, `Heavy rain`, or `Thunderstorms`.
- The forecast always contains exactly 3 days starting from tomorrow.
- Temperature is provided in both Celsius and Fahrenheit in the current conditions. The forecast uses Celsius only.
- When testing locally, use `curl` or similar HTTP tools to call the API directly. Do not use web search to look up weather data.
