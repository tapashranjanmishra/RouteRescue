
const $ = id => document.getElementById(id);

let map, routeLayer, markers = [];
let locations = { from: null, to: null };
let routes = [];
let selectedRoute = 0;
let busTimer;

// Map setup
map = L.map("map").setView([26.18, 91.78], 11);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

// Location search using Photon
function setupAutocomplete(id, boxId) {
  const input = $(id);
  const box = $(boxId);
  let timer, controller;

  input.addEventListener("input", () => {
    clearTimeout(timer);
    if (controller) controller.abort();

    locations[id] = null;
    box.innerHTML = "";

    const query = input.value.trim();
    if (query.length < 2) return;

    box.style.display = "block";
    box.innerHTML = '<div class="suggestion-hint">Searching...</div>';

    timer = setTimeout(async () => {
      controller = new AbortController();

      try {
        const response = await fetch(
          `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=6`,
          { signal: controller.signal }
        );

        const data = await response.json();
        box.innerHTML = "";

        if (!data.features.length) {
          box.innerHTML = '<div class="suggestion-hint">No locations found</div>';
          return;
        }

        data.features.forEach(place => {
          const p = place.properties;
          const name = p.name || p.city || p.street || "Unknown location";
          const address = [p.city, p.state, p.country]
            .filter((v, i, a) => v && a.indexOf(v) === i && v !== name)
            .join(", ");

          const button = document.createElement("button");
          button.type = "button";
          button.className = "suggestion-item";
          button.textContent = [name, address].filter(Boolean).join(", ");

          button.addEventListener("click", () => {
            input.value = button.textContent;
            locations[id] = {
              name: input.value,
              coords: place.geometry.coordinates
            };
            box.style.display = "none";
            $("planner").classList.remove("suggestions-open");
          });

          box.appendChild(button);
        });

        $("planner").classList.add("suggestions-open");

      } catch (error) {
        if (error.name !== "AbortError") {
          box.innerHTML = '<div class="suggestion-hint">Search unavailable</div>';
        }
      }
    }, 300);
  });

  document.addEventListener("click", e => {
    if (!input.contains(e.target) && !box.contains(e.target)) {
      box.style.display = "none";
      $("planner").classList.remove("suggestions-open");
    }
  });
}

setupAutocomplete("from", "fromSuggestions");
setupAutocomplete("to", "toSuggestions");

// Get coordinates if a suggestion was not selected
async function getLocation(id) {
  if (locations[id] && locations[id].name === $(id).value) {
    return locations[id];
  }

  const query = $(id).value.trim();
  if (!query) throw new Error("Please enter both locations.");

  const response = await fetch(
    `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=1`
  );

  const data = await response.json();
  if (!data.features.length) throw new Error(`Location not found: ${query}`);

  const place = data.features[0];
  const p = place.properties;
  const name = [p.name, p.city, p.state].filter(Boolean).join(", ");

  return {
    name: name || query,
    coords: place.geometry.coordinates
  };
}

// Find routes using OSRM
async function findRoutes(from, to) {
  const [lon1, lat1] = from.coords;
  const [lon2, lat2] = to.coords;

  const url =
    `https://router.project-osrm.org/route/v1/driving/` +
    `${lon1},${lat1};${lon2},${lat2}?alternatives=true&overview=full&geometries=geojson`;

  const response = await fetch(url);
  const data = await response.json();

  if (data.code !== "Ok" || !data.routes.length) {
    throw new Error("No route found. Try different locations.");
  }

  return data.routes;
}

// Display route options
function displayRoutes() {
  const list = $("routeList");
  list.innerHTML = "";

  $("resultCount").textContent = `${routes.length} OPTIONS`;

  routes.forEach((route, index) => {
    const minutes = Math.round(route.duration / 60);
    const km = (route.distance / 1000).toFixed(1);

    const card = document.createElement("article");
    card.className = `route-card ${index === selectedRoute ? "selected" : ""}`;

    const info = document.createElement("div");
    const heading = document.createElement("h3");
    heading.textContent = `Route ${index + 1}`;

    const desc = document.createElement("p");
    desc.textContent = `${km} km · Driving route`;

    info.append(heading, desc);

    const metrics = document.createElement("div");
    metrics.className = "route-metrics";

    const time = document.createElement("strong");
    time.textContent = `${minutes} min`;

    metrics.appendChild(time);

    const bottom = document.createElement("div");
    bottom.className = "route-card-bottom";
    bottom.textContent = `Distance: ${km} km`;

    card.append(info, metrics, bottom);
    card.addEventListener("click", () => {
      selectedRoute = index;
      displayRoutes();
      showSelectedRoute();
    });

    list.appendChild(card);
  });
}

// Draw selected route on Leaflet
function showSelectedRoute() {
  const route = routes[selectedRoute];
  if (!route) return;

  if (routeLayer) map.removeLayer(routeLayer);
  markers.forEach(marker => map.removeLayer(marker));
  markers = [];

  const coords = route.geometry.coordinates.map(([lon, lat]) => [lat, lon]);

  routeLayer = L.polyline(coords, {
    color: "#32836d",
    weight: 5
  }).addTo(map);

  markers.push(
    L.marker(coords[0]).addTo(map).bindPopup("Starting point"),
    L.marker(coords[coords.length - 1]).addTo(map).bindPopup("Destination")
  );

  map.fitBounds(routeLayer.getBounds(), { padding: [35, 35] });

  const minutes = Math.round(route.duration / 60);
  const distance = (route.distance / 1000).toFixed(1);

  $("selectedTitle").textContent = `Route ${selectedRoute + 1}`;
  $("summaryFrom").textContent = locations.from.name;
  $("summaryTo").textContent = locations.to.name;
  $("summaryDuration").textContent = `${minutes} min · ${distance} km`;
  $("summaryWait").textContent = "12 min";
  $("summaryEta").textContent = `${minutes + 12} min`;
  $("summaryTransfers").textContent = "0";
  $("nextBusTime").textContent = "12 min";
  $("nextBusLabel").textContent = "Sample bus service";

  startBusMovement(coords);
}

// Simulated bus marker
function startBusMovement(coords) {
  if (busTimer) clearInterval(busTimer);

  const busIcon = L.divIcon({
    className: "",
    html: '<div class="bus-marker">B</div>',
    iconSize: [27, 27],
    iconAnchor: [13, 13]
  });

  const bus = L.marker(coords[0], { icon: busIcon }).addTo(map);
  let position = 0;

  busTimer = setInterval(() => {
    position = Math.min(position + 1, coords.length - 1);
    bus.setLatLng(coords[position]);

    if (position === coords.length - 1) clearInterval(busTimer);
  }, 1000);

  markers.push(bus);
}

// Search form
$("journeyForm").addEventListener("submit", async e => {
  e.preventDefault();

  const button = e.submitter;
  button.disabled = true;
  $("formMessage").textContent = "Finding routes...";

  try {
    const from = await getLocation("from");
    const to = await getLocation("to");

    locations.from = from;
    locations.to = to;

    routes = await findRoutes(from, to);
    selectedRoute = 0;

    displayRoutes();
    showSelectedRoute();

    $("formMessage").textContent = "Routes found successfully.";

  } catch (error) {
    $("formMessage").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

// Swap locations
$("swapBtn").addEventListener("click", () => {
  const fromInput = $("from");
  const toInput = $("to");

  [fromInput.value, toInput.value] =
    [toInput.value, fromInput.value];

  [locations.from, locations.to] =
    [locations.to, locations.from];

  $("fromSuggestions").style.display = "none";
  $("toSuggestions").style.display = "none";
});

// Delay demonstration
$("delayDemoBtn").addEventListener("click", () => {
  $("delayAlert").style.display = "block";
  $("delayAlert").textContent =
    "Sample alert: The bus is delayed by 10 minutes.";

  $("nextBusTime").textContent = "22 min";
  $("summaryWait").textContent = "22 min";
});

// Initial map size adjustment
setTimeout(() => map.invalidateSize(), 300);

const busSchedule = [
  { number: "AS-01-1027", time: "2:15 PM", type: "City Bus" },
  { number: "AS-01-2045", time: "2:35 PM", type: "City Bus" },
  { number: "AS-01-3018", time: "2:55 PM", type: "City Bus" },
  { number: "AS-01-4052", time: "3:20 PM", type: "City Bus" }
];

const scheduleBox = document.getElementById("busSchedule");

if (scheduleBox) {
  scheduleBox.innerHTML = `
    <h4>Upcoming bus departures</h4>
    ${busSchedule.map(bus => `
      <div class="bus-row">
        <div>
          <strong>${bus.number}</strong><br>
          <span>${bus.type}</span>
        </div>
        <span class="bus-time">${bus.time}</span>
      </div>
    `).join("")}
    <small>Illustrative schedule · Not live transport data</small>
  `;
}
let trackingProgress = 35;

function updateBusTracking() {
  const bar = document.getElementById("trackingProgress");
  const percent = document.getElementById("trackingPercent");
  const eta = document.getElementById("trackingETA");
  const location = document.getElementById("trackingLocation");

  if (!bar || !percent || !eta || !location) return;

  trackingProgress += 5;

  if (trackingProgress > 100) trackingProgress = 10;

  bar.style.width = trackingProgress + "%";
  percent.textContent = trackingProgress + "%";

  const remaining = Math.ceil((100 - trackingProgress) / 5);
  eta.textContent = remaining + " min";

  location.textContent =
    trackingProgress < 50
      ? "Bus moving towards destination"
      : trackingProgress < 85
      ? "Bus nearing destination"
      : "Bus arriving shortly";
}

setInterval(updateBusTracking, 5000);