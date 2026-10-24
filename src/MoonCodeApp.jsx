import React, { useEffect, useId, useMemo, useState, useRef } from "react";
import "./index.css";
import { supabase } from "./supabaseClient";

import moonMapUrl from "./assets/moon_map.jpg";

/** ---------------------------
 *  Helpers: Supabase I/O
 *  --------------------------*/

function pgQuote(value) {
  const v = String(value ?? "").replace(/"/g, '\\"');
  return `"${v}"`;
}

async function fetchMessagesForUser(userName) {
  const u = userName.trim();
  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .or(`sender.eq.${pgQuote(u)},recipient.eq.${pgQuote(u)}`)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data ?? [];
}

async function insertMessage({ sender, recipient, body, sendPhoto }) {
  const { data, error } = await supabase
    .from("messages")
    .insert({
      sender,
      recipient,
      body,
      locked: true,
      send_photo: sendPhoto ?? null,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function unlockMessage({ id, receivePhoto }) {
  const { data, error } = await supabase
    .from("messages")
    .update({
      locked: false,
      receive_photo: receivePhoto ?? null,
      receive_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

function mapRowToMessage(row, viewerName) {
  const viewer = viewerName?.trim() || "You";
  const isSender = row.sender === viewer;

  return {
    id: row.id,
    from: isSender ? "You" : row.sender,
    to: isSender ? row.recipient : "You",
    body: row.body,
    locked: !!row.locked,
    sentAt: row.created_at,
    receiveAt: row.receive_at ?? null,
    sendPhoto: row.send_photo ?? null,
    receivePhoto: row.receive_photo ?? null,
    archived: !!row.receive_photo,
    rawSender: row.sender,
    rawRecipient: row.recipient,
  };
}

function showSupabaseError(e, fallback = "Supabase error") {
  console.error(e);
  if (e instanceof TypeError || /failed to fetch|load failed|network/i.test(e?.message || "")) {
    alert("Couldn't reach the mailbox. The Supabase project may be paused — restore it from the Supabase dashboard.");
    return;
  }
  const msg =
    e?.message ||
    e?.error_description ||
    e?.details ||
    (typeof e === "string" ? e : null) ||
    fallback;
  alert(msg);
}

/** ---------------------------
 *  Exhibition Lock (case-sensitive)
 *  Only affects exactly "Person A" and "Person B"
 *  --------------------------*/

const EXHIBITION_A = "Person A";
const EXHIBITION_B = "Person B";

const EXHIBITION_MESSAGE =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.";

function isExhibitionUser(name = "") {
  return name === EXHIBITION_A || name === EXHIBITION_B;
}

function getLockedCounterparty(name = "") {
  if (name === EXHIBITION_A) return EXHIBITION_B;
  if (name === EXHIBITION_B) return EXHIBITION_A;
  return null;
}

/** ---------------------------
 *  Moon Model Configuration
 *  FIXED: Using import.meta.env.BASE_URL for GitHub Pages
 *  --------------------------*/

const TM_MODEL_URL = import.meta.env.BASE_URL + "moon-model/model.json";
const TM_METADATA_URL = import.meta.env.BASE_URL + "moon-model/metadata.json";

// Must match EXACTLY what's in your metadata.json labels array
const MOON_CLASS_NAME = "Moon";

// Confidence threshold: lower = more permissive, higher = stricter
const MOON_THRESHOLD = 0.70;

/** ---------------------------
 *  MoonCameraCapture Component - REAL CAMERA + ML VERIFICATION
 *  --------------------------*/

function MoonCameraCapture({
  title,
  subtitle,
  onVerifiedMoon,
  onBack,
  locationLabel,
  locationCoords,
  step,
}) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  const [model, setModel] = useState(null);
  const [labels, setLabels] = useState([]);
  const [modelLoading, setModelLoading] = useState(true);
  const [modelError, setModelError] = useState("");

  const [stream, setStream] = useState(null);
  const [cameraError, setCameraError] = useState("");
  const [cameraReady, setCameraReady] = useState(false);

  const [capturedDataUrl, setCapturedDataUrl] = useState(null);
  const [verifying, setVerifying] = useState(false);
  const [resultText, setResultText] = useState("");
  const [resultTone, setResultTone] = useState("neutral");
  const [restartToken, setRestartToken] = useState(0);

  // 1. Load Teachable Machine model
  useEffect(() => {
    let alive = true;

    async function loadModel() {
      setModelLoading(true);
      setModelError("");

      try {
        console.log("🔍 Loading model from:", TM_MODEL_URL);
        console.log("🔍 Loading metadata from:", TM_METADATA_URL);

        // First, verify the files are accessible
        const modelCheck = await fetch(TM_MODEL_URL);
        if (!modelCheck.ok) {
          throw new Error(
            `model.json not found (${modelCheck.status}). URL: ${TM_MODEL_URL}`
          );
        }
        console.log("✅ model.json accessible");

        const metaCheck = await fetch(TM_METADATA_URL);
        if (!metaCheck.ok) {
          throw new Error(
            `metadata.json not found (${metaCheck.status}). URL: ${TM_METADATA_URL}`
          );
        }
        const metadata = await metaCheck.json();
        console.log("✅ metadata.json accessible, labels:", metadata.labels);

        if (!alive) return;
        setLabels(metadata.labels || []);

        // Try loading with @teachablemachine/image first
        try {
          const tmImage = await import("@teachablemachine/image");
          const loadedModel = await tmImage.load(TM_MODEL_URL, TM_METADATA_URL);
          if (!alive) return;
          setModel({ type: "tm", model: loadedModel });
          console.log("✅ Model loaded via @teachablemachine/image");
        } catch (tmError) {
          console.warn(
            "⚠️ tmImage failed, trying TensorFlow.js directly:",
            tmError
          );

          // Fallback: Load with TensorFlow.js directly
          const tf = await import("@tensorflow/tfjs");
          const loadedModel = await tf.loadLayersModel(TM_MODEL_URL);
          if (!alive) return;
          setModel({ type: "tf", model: loadedModel, labels: metadata.labels });
          console.log("✅ Model loaded via TensorFlow.js");
        }
      } catch (e) {
        console.error("❌ Model loading failed:", e);
        if (alive) {
          setModelError(e.message || "Failed to load moon detection model");
        }
      } finally {
        if (alive) setModelLoading(false);
      }
    }

    loadModel();
    return () => {
      alive = false;
    };
  }, []);

  // 2. Start camera
  useEffect(() => {
    let alive = true;
    let currentStream = null;

    async function startCamera() {
      try {
        setCameraError("");
        setCameraReady(false);

        // Request camera with preference for back camera on mobile
        const mediaStream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 720 },
            height: { ideal: 1280 },
            aspectRatio: { ideal: 3 / 4 },
          },
          audio: false,
        });

        if (!alive) {
          mediaStream.getTracks().forEach((t) => t.stop());
          return;
        }

        currentStream = mediaStream;
        setStream(mediaStream);

        if (videoRef.current) {
          videoRef.current.srcObject = mediaStream;

          // Wait for video to be ready
          videoRef.current.onloadedmetadata = () => {
            if (alive && videoRef.current) {
              videoRef.current
                .play()
                .then(() => {
                  console.log(
                    "✅ Camera started, dimensions:",
                    videoRef.current.videoWidth,
                    "x",
                    videoRef.current.videoHeight
                  );
                  setCameraReady(true);
                })
                .catch((err) => {
                  console.error("Video play error:", err);
                  setCameraError("Could not start video playback");
                });
            }
          };
        }
      } catch (e) {
        console.error("❌ Camera error:", e);
        if (alive) {
          if (e.name === "NotAllowedError") {
            setCameraError(
              "Camera permission denied. Please allow camera access in your browser settings."
            );
          } else if (e.name === "NotFoundError") {
            setCameraError("No camera found on this device.");
          } else if (e.name === "NotReadableError") {
            setCameraError("Camera is in use by another application.");
          } else {
            setCameraError(`Camera error: ${e.message}`);
          }
        }
      }
    }

    startCamera();

    return () => {
      alive = false;
      if (currentStream) {
        currentStream.getTracks().forEach((t) => t.stop());
      }
    };
  }, [restartToken]);

  // Cleanup stream on unmount
  useEffect(() => {
    return () => {
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
      }
    };
  }, [stream]);

  // 3. Take photo
  const takePhoto = () => {
    setResultText("");
    const video = videoRef.current;
    const canvas = canvasRef.current;

    if (!video || !canvas) {
      console.error("Video or canvas not available");
      return;
    }

    const w = video.videoWidth || 640;
    const h = video.videoHeight || 480;

    console.log("📷 Capturing photo at", w, "x", h);

    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, w, h);

    const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
    setCapturedDataUrl(dataUrl);
    console.log("📷 Photo captured successfully");
  };

  const retake = () => {
    setCapturedDataUrl(null);
    setResultText("");
    setVerifying(false);
    setCameraReady(false);
    setRestartToken((token) => token + 1);
  };

  // 4. Verify moon with model
  const verifyMoon = async () => {
    if (!model) {
      setResultText("Model not loaded yet. Please wait.");
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) {
      setResultText("Canvas not available.");
      return;
    }

    setVerifying(true);
    setResultTone("neutral");
    setResultText("Reading the light…");

    try {
      let predictions;

      if (model.type === "tm") {
        // Teachable Machine model
        predictions = await model.model.predict(canvas);
      } else {
        // TensorFlow.js direct model
        const tf = await import("@tensorflow/tfjs");

        // Preprocess: resize to 224x224, normalize to [-1, 1]
        const tensor = tf.browser
          .fromPixels(canvas)
          .resizeBilinear([224, 224])
          .toFloat()
          .div(tf.scalar(127.5))
          .sub(tf.scalar(1))
          .expandDims(0);

        const output = await model.model.predict(tensor).data();
        tensor.dispose();

        predictions = model.labels.map((label, i) => ({
          className: label,
          probability: output[i],
        }));
      }

      console.log("🔮 Predictions:", predictions);

      // Find moon class prediction (case-insensitive)
      const moonPred = predictions.find(
        (p) => p.className.toLowerCase() === MOON_CLASS_NAME.toLowerCase()
      );
      const moonProb = moonPred?.probability ?? 0;

      console.log(`🌙 Moon confidence: ${Math.round(moonProb * 100)}%`);

      if (moonProb >= MOON_THRESHOLD) {
        setResultTone("success");
        setResultText(`Moon verified · ${Math.round(moonProb * 100)}% confidence`);

        // Small delay to show success message before proceeding
        setTimeout(() => {
          onVerifiedMoon({
            dataUrl: capturedDataUrl,
            confidence: moonProb,
            verifiedAt: new Date().toISOString(),
            location: locationLabel || "",
            coords: locationCoords || null,
          });
        }, 1000);
      } else {
        const notMoonPred = predictions.find(
          (p) => p.className.toLowerCase() !== MOON_CLASS_NAME.toLowerCase()
        );
        setResultTone("warning");
        setResultText(
          `No moon found · ${Math.round(moonProb * 100)}% moon, ${Math.round(
            (notMoonPred?.probability || 0) * 100
          )}% not. Aim at the moon and retake.`
        );
      }
    } catch (e) {
      console.error("❌ Verification error:", e);
      setResultTone("warning");
      setResultText(`Verification failed: ${e.message}`);
    } finally {
      setVerifying(false);
    }
  };

  // Render
  const hasError = cameraError || modelError;
  const isReady = !modelLoading && cameraReady && !hasError;
  const verified = resultTone === "success";

  const lensNote = !capturedDataUrl && !cameraReady ? "Opening the lens…" : "";

  return (
    <div className="app-shell capture">
      <TopBar onBack={onBack} step={step} dark />

      <header className="capture-title">
        <h2 className="display">{title}</h2>
        <p className="mono-label">{subtitle}</p>
      </header>

      {hasError ? (
        <div className="capture-error">
          <p className="mono-label">{modelError ? "Model error" : "Camera error"}</p>
          <p>{modelError || cameraError}</p>
          {cameraError && (
            <button className="btn btn--ghost-dark" onClick={retake}>
              Try again
            </button>
          )}
        </div>
      ) : (
        <div
          className={`viewport ${verifying ? "is-scanning" : ""} ${verified ? "is-locked" : ""} ${
            capturedDataUrl ? "has-shot" : ""
          }`}
        >
          <TickRing />
          <div className="viewport-lens">
            {!capturedDataUrl ? (
              <video ref={videoRef} playsInline muted autoPlay />
            ) : (
              <img src={capturedDataUrl} alt="Captured moon" />
            )}
            {lensNote && <span className="viewport-note mono-label">{lensNote}</span>}
          </div>
          <canvas ref={canvasRef} style={{ display: "none" }} />
        </div>
      )}

      {!hasError && (
        <>
          <p className={`capture-status capture-status--${resultText ? resultTone : "neutral"}`}>
            {resultText ||
              (modelLoading
                ? "Loading moon detection…"
                : capturedDataUrl
                ? "Verify to seal with this moon"
                : "Centre the moon inside the circle")}
          </p>

          <div className="capture-controls">
            {!capturedDataUrl ? (
              <button
                onClick={takePhoto}
                className="shutter"
                disabled={!isReady}
                aria-label="Take photo"
                title={isReady ? "Take photo" : "Waiting for camera and model..."}
              >
                <span />
              </button>
            ) : (
              <>
                <button onClick={retake} className="btn btn--ghost-dark" disabled={verifying || verified}>
                  Retake
                </button>
                <button
                  onClick={verifyMoon}
                  className="btn btn--light"
                  disabled={verifying || modelLoading || verified}
                >
                  {verifying ? "Checking…" : verified ? "Verified" : "Verify moon"}
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** ---------------------------
 *  Moon phase utilities
 *  --------------------------*/

const LOCATION_OPTIONS = [
  "New York, USA (UTC-5)",
  "Los Angeles, USA (UTC-8)",
  "Chicago, USA (UTC-6)",
  "Miami, USA (UTC-5)",
  "Toronto, Canada (UTC-5)",
  "Vancouver, Canada (UTC-8)",
  "Mexico City, Mexico (UTC-6)",
  "Bogotá, Colombia (UTC-5)",
  "Lima, Peru (UTC-5)",
  "Santiago, Chile (UTC-4)",
  "Buenos Aires, Argentina (UTC-3)",
  "São Paulo, Brazil (UTC-3)",
  "Reykjavík, Iceland (UTC+0)",
  "Dublin, Ireland (UTC+0)",
  "London, UK (UTC+0)",
  "Lisbon, Portugal (UTC+0)",
  "Madrid, Spain (UTC+1)",
  "Paris, France (UTC+1)",
  "Amsterdam, Netherlands (UTC+1)",
  "Berlin, Germany (UTC+1)",
  "Rome, Italy (UTC+1)",
  "Prague, Czechia (UTC+1)",
  "Vienna, Austria (UTC+1)",
  "Warsaw, Poland (UTC+1)",
  "Athens, Greece (UTC+2)",
  "Cape Town, South Africa (UTC+2)",
  "Johannesburg, South Africa (UTC+2)",
  "Cairo, Egypt (UTC+2)",
  "Nairobi, Kenya (UTC+3)",
  "Istanbul, Türkiye (UTC+3)",
  "Dubai, UAE (UTC+4)",
  "Riyadh, Saudi Arabia (UTC+3)",
  "Tehran, Iran (UTC+3)",
  "Mumbai, India (UTC+5)",
  "Delhi, India (UTC+5)",
  "Karachi, Pakistan (UTC+5)",
  "Dhaka, Bangladesh (UTC+6)",
  "Bangkok, Thailand (UTC+7)",
  "Jakarta, Indonesia (UTC+7)",
  "Singapore (UTC+8)",
  "Hong Kong (UTC+8)",
  "Beijing, China (UTC+8)",
  "Seoul, South Korea (UTC+9)",
  "Tokyo, Japan (UTC+9)",
  "Manila, Philippines (UTC+8)",
  "Hanoi, Vietnam (UTC+7)",
  "Auckland, New Zealand (UTC+12)",
  "Sydney, Australia (UTC+10)",
  "Melbourne, Australia (UTC+10)",
  "Brisbane, Australia (UTC+10)",
];

const LOCATION_COORDS = {
  "New York, USA": { lat: 40.7128, lon: -74.006 },
  "Los Angeles, USA": { lat: 34.0522, lon: -118.2437 },
  "Chicago, USA": { lat: 41.8781, lon: -87.6298 },
  "Miami, USA": { lat: 25.7617, lon: -80.1918 },
  "Toronto, Canada": { lat: 43.6532, lon: -79.3832 },
  "Vancouver, Canada": { lat: 49.2827, lon: -123.1207 },
  "Mexico City, Mexico": { lat: 19.4326, lon: -99.1332 },
  "Bogotá, Colombia": { lat: 4.711, lon: -74.0721 },
  "Lima, Peru": { lat: -12.0464, lon: -77.0428 },
  "Santiago, Chile": { lat: -33.4489, lon: -70.6693 },
  "Buenos Aires, Argentina": { lat: -34.6037, lon: -58.3816 },
  "São Paulo, Brazil": { lat: -23.5505, lon: -46.6333 },
  "Reykjavík, Iceland": { lat: 64.1466, lon: -21.9426 },
  "Dublin, Ireland": { lat: 53.3498, lon: -6.2603 },
  "London, UK": { lat: 51.5074, lon: -0.1278 },
  "Lisbon, Portugal": { lat: 38.7223, lon: -9.1393 },
  "Madrid, Spain": { lat: 40.4168, lon: -3.7038 },
  "Paris, France": { lat: 48.8566, lon: 2.3522 },
  "Amsterdam, Netherlands": { lat: 52.3676, lon: 4.9041 },
  "Berlin, Germany": { lat: 52.52, lon: 13.405 },
  "Rome, Italy": { lat: 41.9028, lon: 12.4964 },
  "Prague, Czechia": { lat: 50.0755, lon: 14.4378 },
  "Vienna, Austria": { lat: 48.2082, lon: 16.3738 },
  "Warsaw, Poland": { lat: 52.2297, lon: 21.0122 },
  "Athens, Greece": { lat: 37.9838, lon: 23.7275 },
  "Cape Town, South Africa": { lat: -33.9249, lon: 18.4241 },
  "Johannesburg, South Africa": { lat: -26.2041, lon: 28.0473 },
  "Cairo, Egypt": { lat: 30.0444, lon: 31.2357 },
  "Nairobi, Kenya": { lat: -1.2921, lon: 36.8219 },
  "Istanbul, Türkiye": { lat: 41.0082, lon: 28.9784 },
  "Dubai, UAE": { lat: 25.2048, lon: 55.2708 },
  "Riyadh, Saudi Arabia": { lat: 24.7136, lon: 46.6753 },
  "Tehran, Iran": { lat: 35.6892, lon: 51.389 },
  "Mumbai, India": { lat: 19.076, lon: 72.8777 },
  "Delhi, India": { lat: 28.6139, lon: 77.209 },
  "Karachi, Pakistan": { lat: 24.8607, lon: 67.0011 },
  "Dhaka, Bangladesh": { lat: 23.8103, lon: 90.4125 },
  "Bangkok, Thailand": { lat: 13.7563, lon: 100.5018 },
  "Jakarta, Indonesia": { lat: -6.2088, lon: 106.8456 },
  "Singapore": { lat: 1.3521, lon: 103.8198 },
  "Hong Kong": { lat: 22.3193, lon: 114.1694 },
  "Beijing, China": { lat: 39.9042, lon: 116.4074 },
  "Seoul, South Korea": { lat: 37.5665, lon: 126.978 },
  "Tokyo, Japan": { lat: 35.6762, lon: 139.6503 },
  "Manila, Philippines": { lat: 14.5995, lon: 120.9842 },
  "Hanoi, Vietnam": { lat: 21.0278, lon: 105.8342 },
  "Auckland, New Zealand": { lat: -36.8485, lon: 174.7633 },
  "Sydney, Australia": { lat: -33.8688, lon: 151.2093 },
  "Melbourne, Australia": { lat: -37.8136, lon: 144.9631 },
  "Brisbane, Australia": { lat: -27.4698, lon: 153.0251 },
};

const MOON_PHASES = [
  {
    name: "New Moon",
    meaning: "beginnings",
    personalMessage:
      "Blank page energy. Write the letter you’ve been avoiding. Begin with “I’ve been meaning to tell you…”",
  },
  {
    name: "Waxing Crescent",
    meaning: "intentions",
    personalMessage:
      "Hope in small, stubborn ways. Write to someone you miss: one memory, one update, one wish.",
  },
  {
    name: "First Quarter",
    meaning: "decisions",
    personalMessage:
      "Half sure, half terrified. Write the letter that decides: an apology, a confession, a yes.",
  },
  {
    name: "Waxing Gibbous",
    meaning: "refinement",
    personalMessage:
      "You’re close to saying what you mean. Write what you appreciate, and what you’re learning.",
  },
  {
    name: "Full Moon",
    meaning: "culmination",
    personalMessage:
      "Feelings have stage lighting. Write the big letter. Don’t be cool—tell them what they changed in you.",
  },
  {
    name: "Waning Gibbous",
    meaning: "gratitude",
    personalMessage:
      "Soft afterglow. Say thank you: one thing they did, and why it mattered.",
  },
  {
    name: "Last Quarter",
    meaning: "release",
    personalMessage:
      "The exhale. Write to something you’re done holding. Name what you release, and what you keep.",
  },
  {
    name: "Waning Crescent",
    meaning: "rest",
    personalMessage:
      "Low battery, high intuition. Write something short and gentle, almost a whisper.",
  },
];

const MS_PER_HOUR = 1000 * 60 * 60;
const MS_PER_DAY = 1000 * 60 * 60 * 24;
const SYNODIC_MONTH = 29.53058867;
const KNOWN_NEW_MOON = new Date(Date.UTC(2000, 0, 6, 18, 14, 0));

// Fallback local calculation (used if API fails)
const getMoonPhaseLocal = (date) => {
  const { fraction } = getMoonInfo(date);
  const phaseIndex = Math.floor(fraction * 8 + 0.5) % 8;
  return MOON_PHASES[phaseIndex];
};

// Age (days), cycle fraction (0 = new, 0.5 = full) and lit share of the disc
function getMoonInfo(date) {
  const daysSince = (date - KNOWN_NEW_MOON) / MS_PER_DAY;
  const age = ((daysSince % SYNODIC_MONTH) + SYNODIC_MONTH) % SYNODIC_MONTH;
  const fraction = age / SYNODIC_MONTH;
  const illumination = (1 - Math.cos(2 * Math.PI * fraction)) / 2;
  return { age, fraction, illumination };
}

const getDistanceMiles = (fromLocation, toLocation, fromCoords, toCoords) => {
  const from = fromCoords;
  const to = toCoords;
  if (!from || !to) return null;

  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(to.lat - from.lat);
  const dLon = toRad(to.lon - from.lon);
  const lat1 = toRad(from.lat);
  const lat2 = toRad(to.lat);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const km = 6371 * c;
  return Math.round(km * 0.621371);
};

const formatFullDate = (date) =>
  date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

const formatShortDateTime = (date) =>
  date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

const getTimeBasedGreeting = (timezone) => {
  let hour;

  if (timezone) {
    try {
      const formatter = new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        hour12: false,
        timeZone: timezone,
      });
      hour = parseInt(formatter.format(new Date()), 10);
    } catch {
      hour = new Date().getHours();
    }
  } else {
    hour = new Date().getHours();
  }

  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 17) return "Good afternoon";
  if (hour >= 17 && hour < 21) return "Good evening";
  return "Good night";
};

/** ---------------------------
 *  UI Components
 *  --------------------------*/

// Length of the fold → seal → fly sequence on the letter screen (keep in sync with index.css)
const SEAL_ANIMATION_MS = 2050;
const PRINT_DURATION_MS = 3600;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const formatDayStamp = (date) =>
  date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

const pad2 = (n) => String(n).padStart(2, "0");

// SVG path for the lit part of a moon disc (fraction: 0 = new, 0.5 = full)
function moonLitPath(fraction, c, r) {
  const cosF = Math.cos(2 * Math.PI * fraction);
  const rx = Math.abs(cosF) * r;
  const waxing = fraction < 0.5;
  const outerSweep = waxing ? 1 : 0;
  const termSweep = waxing ? (cosF > 0 ? 0 : 1) : cosF > 0 ? 1 : 0;
  return `M ${c} ${c - r} A ${r} ${r} 0 0 ${outerSweep} ${c} ${c + r} A ${rx} ${r} 0 0 ${termSweep} ${c} ${c - r} Z`;
}

const Icon = ({ children, size = 20 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.3"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

const IconHome = () => (
  <Icon>
    <path d="M4 10.5 12 4l8 6.5V20H4z" />
    <path d="M10 20v-5.5h4V20" />
  </Icon>
);

const IconPen = () => (
  <Icon size={22}>
    <path d="M15.5 4.5 19.5 8.5 9 19H5v-4z" />
    <path d="M13.5 6.5l4 4" />
  </Icon>
);

const IconLetter = () => (
  <Icon>
    <rect x="3.5" y="6" width="17" height="12" rx="1" />
    <path d="M3.5 6.5 12 13l8.5-6.5" />
  </Icon>
);

const IconArrow = ({ dir = "right" }) => (
  <Icon size={16}>
    {dir === "right" ? <path d="M4 12h15M14 7l5 5-5 5" /> : <path d="M20 12H5M10 7l-5 5 5 5" />}
  </Icon>
);

// Grayscale albedo of the lunar surface (NASA SVS CGI Moon Kit, equirectangular, public domain)
let moonMapPromise = null;
function loadMoonMap() {
  moonMapPromise ??= new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, img.width, img.height);
      const gray = new Float32Array(img.width * img.height);
      for (let i = 0; i < gray.length; i++) {
        gray[i] = (data[i * 4] * 0.3 + data[i * 4 + 1] * 0.59 + data[i * 4 + 2] * 0.11) / 255;
      }
      resolve({ w: img.width, h: img.height, gray });
    };
    img.onerror = reject;
    img.src = moonMapUrl;
  });
  return moonMapPromise;
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// Light the near side for the given cycle fraction and bucket it into stitch levels (0–4)
function computeStitches(map, fraction, size, cell) {
  const theta = 2 * Math.PI * fraction;
  const sun = [Math.sin(theta), 0, -Math.cos(theta)];
  const r = size / 2;
  const n = Math.floor(size / cell);
  const offset = (size - n * cell) / 2;
  const stitches = [];

  const albedoAt = (x, y, z) => {
    const lat = Math.asin(-y);
    const lon = Math.atan2(x, z);
    const u = Math.floor((0.5 + lon / (2 * Math.PI)) * (map.w - 1));
    const v = Math.floor((0.5 - lat / Math.PI) * (map.h - 1));
    return map.gray[v * map.w + u];
  };

  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const cx = offset + (col + 0.5) * cell;
      const cy = offset + (row + 0.5) * cell;
      const x = (cx - r) / r;
      const y = (cy - r) / r;
      const d2 = x * x + y * y;
      if (d2 > 0.97) continue;
      const z = Math.sqrt(1 - d2);

      // average a few samples per cell so stitches read as tone, not noise
      const q = (cell / r) * 0.25;
      let albedo = 0;
      for (const [dx, dy] of [[-q, -q], [q, -q], [-q, q], [q, q]]) {
        const sx = x + dx;
        const sy = y + dy;
        const sd = Math.min(0.999, sx * sx + sy * sy);
        albedo += albedoAt(sx, sy, Math.sqrt(1 - sd)) / 4;
      }
      albedo = clamp01((albedo - 0.3) / 0.45);

      // the moon stays nearly flat-lit until close to the terminator, so surface detail carries the image
      const mu0 = x * sun[0] + y * sun[1] + z * sun[2];
      const light = mu0 > 0 ? Math.pow(clamp01(mu0 * 5), 0.6) : 0;
      const b = light * (0.25 + 0.75 * albedo);

      // ink marks shadow, like an engraving: dark maria get heavy stitches, bright highlands light ones,
      // and the unlit side is left as bare dots
      const level = b < 0.04 ? 0 : b > 0.78 ? 1 : b > 0.6 ? 2 : b > 0.42 ? 3 : 4;
      stitches.push({ cx, cy, level, d: Math.sqrt(d2) });
    }
  }
  return stitches;
}

const STITCH_STYLE = [
  null,
  { alpha: 0.45, width: 0.8, cross: false },
  { alpha: 0.6, width: 0.9, cross: true },
  { alpha: 0.82, width: 1.15, cross: true },
  { alpha: 1, width: 1.45, cross: true },
];

function drawStitch(ctx, s, cell, p) {
  if (s.level === 0) {
    ctx.globalAlpha = 0.3 * p;
    ctx.beginPath();
    ctx.arc(s.cx, s.cy, cell * 0.08, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const style = STITCH_STYLE[s.level];
  const h = cell * 0.32 * p;
  ctx.globalAlpha = style.alpha;
  ctx.lineWidth = style.width;
  ctx.beginPath();
  ctx.moveTo(s.cx - h, s.cy + h);
  ctx.lineTo(s.cx + h, s.cy - h);
  if (style.cross) {
    ctx.moveTo(s.cx - h, s.cy - h);
    ctx.lineTo(s.cx + h, s.cy + h);
  }
  ctx.stroke();
}

// Real lunar surface, lit for tonight's phase, rendered as cross-stitches
const StitchMoon = ({ fraction = 0.5, size = 232, cell = 5.5, className = "" }) => {
  const canvasRef = useRef(null);

  useEffect(() => {
    let alive = true;
    let raf = 0;

    loadMoonMap()
      .then((map) => {
        const canvas = canvasRef.current;
        if (!alive || !canvas) return;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(size * dpr);
        canvas.height = Math.round(size * dpr);
        const ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const ink = getComputedStyle(canvas).color;
        ctx.strokeStyle = ink;
        ctx.fillStyle = ink;
        ctx.lineCap = "round";

        const stitches = computeStitches(map, fraction, size, cell);
        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const start = performance.now();
        const duration = 1100;

        const frame = (now) => {
          const t = reduceMotion ? 2 : (now - start) / duration;
          ctx.clearRect(0, 0, size, size);
          for (const s of stitches) {
            // stitches appear from the centre outwards
            const p = clamp01((t * 1.25 - s.d) * 5);
            if (p > 0) drawStitch(ctx, s, cell, p);
          }
          if (t < 1.25 + 0.2) raf = requestAnimationFrame(frame);
        };
        raf = requestAnimationFrame(frame);
      })
      .catch((err) => console.error("Moon map failed to load", err));

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, [fraction, size, cell]);

  return (
    <canvas
      ref={canvasRef}
      className={`stitch-moon ${className}`}
      style={{ "--moon-size": `${size}px` }}
      aria-hidden="true"
    />
  );
};

const PhaseGlyph = ({ fraction, size = 16 }) => {
  const c = size / 2;
  const r = c - 1;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={c} cy={c} r={r} fill="none" stroke="currentColor" strokeWidth="0.8" />
      <path d={moonLitPath(fraction, c, r)} fill="currentColor" />
    </svg>
  );
};

// Irregular wax blob with a pressed crescent moon and two small stars
const WAX_EDGE = (() => {
  const points = [];
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    const r = 20.5 + Math.sin(a * 7) * 0.9 + Math.sin(a * 3 + 1.3) * 0.6;
    points.push(`${(22 + Math.cos(a) * r).toFixed(2)} ${(22 + Math.sin(a) * r).toFixed(2)}`);
  }
  return `M ${points.join(" L ")} Z`;
})();

const WaxSeal = ({ size = 44 }) => {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 44 44" aria-hidden="true" className="wax-seal">
      <defs>
        <radialGradient id={`${id}-wax`} cx="38%" cy="32%" r="75%">
          <stop offset="0%" stopColor="#3a3734" />
          <stop offset="60%" stopColor="#1c1b1a" />
          <stop offset="100%" stopColor="#0c0c0c" />
        </radialGradient>
        <mask id={`${id}-crescent`}>
          <circle cx="22" cy="22" r="7.6" fill="#fff" />
          <circle cx="25.6" cy="19.8" r="6.6" fill="#000" />
        </mask>
      </defs>
      <path d={WAX_EDGE} fill={`url(#${id}-wax)`} />
      <circle cx="22" cy="22" r="14.5" fill="none" stroke="rgba(255,255,255,0.16)" strokeWidth="0.7" />
      <circle cx="22" cy="22" r="13.2" fill="none" stroke="rgba(0,0,0,0.45)" strokeWidth="0.6" />
      <circle cx="22" cy="22" r="7.6" fill="#ece6d9" mask={`url(#${id}-crescent)`} />
      <path d="M29.2 14.2l.45 1.1 1.1.45-1.1.45-.45 1.1-.45-1.1-1.1-.45 1.1-.45z" fill="#ece6d9" opacity="0.85" />
      <circle cx="30.4" cy="25.6" r="0.75" fill="#ece6d9" opacity="0.7" />
    </svg>
  );
};

const IconClose = () => (
  <Icon size={18}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);

const PhaseCycle = ({ currentName }) => (
  <ol className="cycle" aria-label="Lunar cycle">
    {MOON_PHASES.map((p, i) => (
      <li
        key={p.name}
        className={`cycle-item ${p.name === currentName ? "is-current" : ""}`}
        title={p.name}
      >
        <PhaseGlyph fraction={i / 8} />
      </li>
    ))}
  </ol>
);

const TickRing = ({ count = 72 }) => (
  <svg className="ticks" viewBox="0 0 200 200" aria-hidden="true">
    {Array.from({ length: count }, (_, i) => {
      const a = (i / count) * Math.PI * 2 - Math.PI / 2;
      const major = i % 6 === 0;
      const r1 = major ? 89 : 92;
      return (
        <line
          key={i}
          x1={100 + Math.cos(a) * r1}
          y1={100 + Math.sin(a) * r1}
          x2={100 + Math.cos(a) * 98}
          y2={100 + Math.sin(a) * 98}
          className={major ? "is-major" : ""}
          style={{ "--i": i }}
        />
      );
    })}
  </svg>
);

const TopBar = ({ onBack, step, total = 3, dark = false }) => (
  <div className={`topbar ${dark ? "topbar--dark" : ""}`}>
    {onBack ? (
      <button onClick={onBack} className="back">
        <IconArrow dir="left" />
        Back
      </button>
    ) : (
      <span />
    )}
    {step && (
      <div className="steps" aria-label={`Step ${step} of ${total}`}>
        <span className="mono-label">
          {pad2(step)} / {pad2(total)}
        </span>
        <span className="steps-bars">
          {Array.from({ length: total }, (_, i) => (
            <i key={i} className={i < step ? "is-on" : ""} />
          ))}
        </span>
      </div>
    )}
  </div>
);

const BottomNav = ({ current, onSelect, onSend }) => (
  <nav className="nav" aria-label="Main">
    <button
      className={`nav-item ${current === "inbox" ? "is-active" : ""}`}
      onClick={() => onSelect("inbox")}
    >
      <IconHome />
      <span className="nav-label">Home</span>
    </button>

    <button className="nav-compose" onClick={onSend} aria-label="Write a letter" title="Write a letter">
      <IconPen />
    </button>

    <button
      className={`nav-item ${current === "gallery" ? "is-active" : ""}`}
      onClick={() => onSelect("gallery")}
    >
      <IconLetter />
      <span className="nav-label">Archive</span>
    </button>
  </nav>
);

const OnboardingScreen = ({
  userData,
  locationQuery,
  locationSuggestions,
  locationLoading,
  onUpdate,
  onLocationChange,
  onSelectLocation,
  onBegin,
  currentPhase,
  moon,
}) => {
  const canBegin = userData.name.trim() && userData.location;

  return (
    <div className="app-shell onboard">
      <div className="home-meta">
        <span className="mono-label">Mooncode</span>
        <span className="mono-label">{formatDayStamp(new Date())}</span>
      </div>

      <div className="onboard-hero stagger">
        <StitchMoon fraction={moon.fraction} size={176} cell={5} />
        <h1 className="display">
          Letters sealed
          <br />
          by <em>moonlight.</em>
        </h1>
      </div>

      <form
        className="onboard-form stagger"
        onSubmit={(e) => {
          e.preventDefault();
          if (canBegin) onBegin();
        }}
      >
        <div className="field">
          <label htmlFor="mc-name" className="mono-label">
            Your name
          </label>
          <input
            id="mc-name"
            type="text"
            autoComplete="given-name"
            placeholder="How should letters find you"
            value={userData.name}
            onChange={(e) => onUpdate("name", e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="mc-location" className="mono-label">
            Where you watch the moon
          </label>
          <input
            id="mc-location"
            type="text"
            autoComplete="off"
            placeholder="City"
            value={locationQuery}
            onChange={(e) => onLocationChange(e.target.value)}
            onFocus={() => onLocationChange(locationQuery)}
          />
          {locationSuggestions.length > 0 && (
            <div className="suggest">
              {locationSuggestions.map((option) => (
                <button
                  type="button"
                  key={`${option.label}-${option.timezone}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onSelectLocation(option);
                  }}
                >
                  <span>{option.label}</span>
                  <small>{option.timezone}</small>
                </button>
              ))}
            </div>
          )}
          {locationLoading && <p className="field-hint">Searching cities…</p>}
        </div>

        <button type="submit" className="btn btn--ink btn--block" disabled={!canBegin}>
          Enter <IconArrow />
        </button>
      </form>

      <p className="mono-label onboard-foot">
        Tonight · {currentPhase.name} · {Math.round(moon.illumination * 100)}% lit
      </p>
    </div>
  );
};

const InboxScreen = ({
  userData,
  messages,
  currentPhase,
  moon,
  moonPhaseLoading,
  onOpen,
  onLogout,
}) => {
  const incoming = messages.filter((msg) => msg.from !== "You");
  const pending = incoming.filter((msg) => (msg.locked || !msg.receivePhoto) && !msg.archived);
  const sent = messages.filter((msg) => msg.from === "You");
  const greeting = getTimeBasedGreeting(userData.locationData?.timezone);

  return (
    <div className="app-shell app-shell--nav">
      <header className="home-head">
        <div className="home-meta">
          <span className="mono-label">{formatDayStamp(new Date())}</span>
          <button onClick={onLogout} className="mono-label link">
            Log out
          </button>
        </div>
        <h1 className="display display--fit">
          {greeting}
          {userData.name ? (
            <>
              , <em>{userData.name}</em>
            </>
          ) : null}
        </h1>
      </header>

      <section className="moon-panel" aria-label="Tonight's moon">
        <StitchMoon fraction={moon.fraction} size={232} />
        <p className="mono-label">Tonight</p>
        <p className="moon-name">{moonPhaseLoading ? "Reading the sky…" : currentPhase.name}</p>

        <div className="stats">
          <div className="stat">
            <span className="mono-label">Light</span>
            <span className="stat-value">{Math.round(moon.illumination * 100)}%</span>
          </div>
          <div className="stat">
            <span className="mono-label">Day</span>
            <span className="stat-value">
              {Math.floor(moon.age) + 1}
              <small>/29</small>
            </span>
          </div>
          <div className="stat">
            <span className="mono-label">For</span>
            <span className="stat-value">{currentPhase.meaning}</span>
          </div>
        </div>

        <PhaseCycle currentName={currentPhase.name} />

        <div className="prompt">
          <p className="mono-label">Tonight's prompt</p>
          <p className="prompt-text">{currentPhase.personalMessage}</p>
        </div>
      </section>

      <section className="list-section">
        <header className="list-head">
          <h2 className="mono-label">Awaiting your moon</h2>
          <span className="mono-label">{pad2(pending.length)}</span>
        </header>
        {pending.length === 0 ? (
          <p className="empty">No sealed letters tonight.</p>
        ) : (
          pending.map((msg, i) => (
            <button
              key={msg.id}
              onClick={() => onOpen(msg)}
              className="row row--pending"
              style={{ animationDelay: `${i * 60}ms` }}
            >
              <span className="row-index">{pad2(i + 1)}</span>
              <span className="row-main">
                <span className="row-sub">From</span>
                <span className="row-name">{msg.from}</span>
              </span>
              <span className="row-meta">
                Unseal <IconArrow />
              </span>
            </button>
          ))
        )}
      </section>

      <section className="list-section">
        <header className="list-head">
          <h2 className="mono-label">Sent</h2>
          <span className="mono-label">{pad2(sent.length)}</span>
        </header>
        {sent.length === 0 ? (
          <p className="empty">Nothing sent yet. Tap the pen to write.</p>
        ) : (
          sent.map((msg, i) => (
            <div key={msg.id} className="row" style={{ animationDelay: `${i * 60}ms` }}>
              <span className="row-index">{pad2(i + 1)}</span>
              <span className="row-main">
                <span className="row-sub">To · {formatShortDateTime(new Date(msg.sentAt))}</span>
                <span className="row-name">{msg.to}</span>
              </span>
              <span className="row-meta">
                <i className={`status-dot ${msg.receivePhoto ? "" : "status-dot--transit"}`} />
                {msg.receivePhoto ? "Opened" : "In transit"}
              </span>
            </div>
          ))
        )}
      </section>
    </div>
  );
};

/** ---------------------------
 *  Select Recipient (locked for exhibition users)
 *  --------------------------*/

const SelectRecipientScreen = ({ onSelect, onBack, defaultValue = "", viewerName = "" }) => {
  const locked = getLockedCounterparty(viewerName);
  const [name, setName] = useState(locked || defaultValue);

  useEffect(() => {
    if (locked) setName(locked);
  }, [locked]);

  return (
    <form
      className="app-shell"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onSelect({ name: name.trim() });
      }}
    >
      <TopBar onBack={onBack} step={2} />

      <div className="step-body stagger">
        <p className="mono-label">Recipient</p>
        <h1 className="display">Who is this letter for?</h1>
        <input
          type="text"
          className="input-xl"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Their name"
          disabled={!!locked}
          autoComplete="off"
          aria-label="Recipient name"
        />
        <p className="field-hint">They'll open it only after capturing their own moon.</p>
      </div>

      <button type="submit" className="btn btn--ink btn--block" disabled={!name.trim()}>
        Continue <IconArrow />
      </button>
    </form>
  );
};

/** ---------------------------
 *  Compose Letter (locked message for exhibition users)
 *  --------------------------*/

const ComposeLetterScreen = ({
  recipient,
  message,
  onChange,
  onSend,
  onSealed,
  onBack,
  currentPhase,
  viewerName = "",
}) => {
  const locked = isExhibitionUser(viewerName);
  const [sending, setSending] = useState(false);
  const stageRef = useRef(null);
  const letterRef = useRef(null);
  const envelopeRef = useRef(null);

  // Size the fold so the letter lands exactly inside the envelope pocket
  const measureFold = () => {
    const stage = stageRef.current;
    const l = letterRef.current.getBoundingClientRect();
    const e = envelopeRef.current.getBoundingClientRect();
    stage.style.setProperty("--fold-sx", ((e.width * 0.86) / l.width).toFixed(4));
    stage.style.setProperty("--fold-sy", ((e.height * 0.76) / l.height).toFixed(4));
    stage.style.setProperty("--fold-dx", `${e.left + e.width / 2 - (l.left + l.width / 2)}px`);
    stage.style.setProperty("--fold-dy", `${e.top + e.height * 0.56 - (l.top + l.height / 2)}px`);
    stage.style.setProperty("--fold-lift", `${e.height * 0.95}px`);
  };

  const handleSend = async () => {
    if (sending) return;
    document.activeElement?.blur?.();
    measureFold();
    setSending(true);
    const animation = wait(SEAL_ANIMATION_MS);
    const ok = await onSend();
    if (!ok) {
      setSending(false);
      return;
    }
    await animation;
    const r = envelopeRef.current.getBoundingClientRect();
    onSealed({ left: r.left, top: r.top, width: r.width, height: r.height });
  };

  return (
    <div className={`app-shell compose ${sending ? "is-sending" : ""}`}>
      <TopBar onBack={sending ? null : onBack} step={3} />

      <div className="letter-stage" ref={stageRef}>
        <div className="envelope-layer envelope-layer--rear" aria-hidden="true">
          <div className="envelope-back" />
        </div>

        <article className="letter" ref={letterRef}>
          <header className="letter-head mono-label">
            <span>Mooncode</span>
            <span>{formatFullDate(new Date())}</span>
          </header>

          <div className="letter-to">
            <span className="mono-label">To</span>
            <span className="letter-name">{recipient?.name}</span>
          </div>

          <textarea
            value={message}
            onChange={(e) => onChange(e.target.value)}
            className="letter-input"
            placeholder="Dear…"
            readOnly={locked || sending}
            aria-label="Your letter"
          />

          <footer className="letter-foot mono-label">
            <span>Under the {currentPhase.name}</span>
            <span>{message.trim() ? message.trim().split(/\s+/).length : 0} words</span>
          </footer>
        </article>

        <div className="envelope-layer envelope-layer--front" ref={envelopeRef} aria-hidden="true">
          <div className="envelope-front" />
        </div>
        <div className="envelope-layer envelope-layer--flap" aria-hidden="true">
          <div className="envelope-flap" />
        </div>
        <div className="envelope-layer envelope-layer--seal" aria-hidden="true">
          <div className="envelope-seal">
            <WaxSeal />
          </div>
        </div>
      </div>

      <div className="compose-foot">
        <button onClick={handleSend} className="btn btn--ink btn--block" disabled={!message.trim() || sending}>
          Seal &amp; send
        </button>
      </div>
    </div>
  );
};

// Dotted flight path in the sky's 300×260 viewBox; the envelope's on-screen width as it travels it
const TRAIL = "M 26 244 Q 58 96 222 71";
const TRAVEL_WIDTH_START = 52;
const TRAVEL_WIDTH_END = 22;
const SHRINK_MS = 700;
const TRAVEL_MS = 1600;

const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

const MessageSentScreen = ({ from, recipient, currentPhase, moon, onDone }) => {
  const onDoneRef = useRef(onDone);
  const trailRef = useRef(null);
  const revealRef = useRef(null);
  const ghostRef = useRef(null);
  const [traveling, setTraveling] = useState(false);

  useEffect(() => {
    onDoneRef.current = onDone;
  });

  useEffect(() => {
    const timer = setTimeout(() => onDoneRef.current(), 7500);
    return () => clearTimeout(timer);
  }, []);

  // The sealed envelope from the letter screen shrinks onto the start of the trail,
  // then flies along it into the moon while the dotted line draws in behind it
  useEffect(() => {
    const anims = [];
    const raf = requestAnimationFrame(() => {
      const svg = trailRef.current;
      const reveal = revealRef.current;
      const ghost = ghostRef.current;
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!from || !svg || !ghost || reduceMotion) {
        if (reveal) reveal.style.strokeDashoffset = "0";
        setTraveling(true);
        return;
      }

      const ctm = svg.getScreenCTM();
      // measure the plain path; the reveal path's pathLength="1" can skew point lookups
      const geometry = svg.querySelector(".trail-dots");
      const length = geometry.getTotalLength();
      const cx = from.left + from.width / 2;
      const cy = from.top + from.height / 2;
      const placeAt = (p, width) => {
        const pt = geometry.getPointAtLength(p * length);
        const screen = new DOMPoint(pt.x, pt.y).matrixTransform(ctm);
        return `translate(${screen.x - cx}px, ${screen.y - cy}px) scale(${width / from.width})`;
      };

      const shrink = ghost.animate([{ transform: "none" }, { transform: placeAt(0, TRAVEL_WIDTH_START) }], {
        duration: SHRINK_MS,
        easing: "cubic-bezier(0.65, 0, 0.35, 1)",
        fill: "forwards",
      });
      anims.push(shrink);

      shrink.onfinish = () => {
        const steps = 40;
        const flight = [];
        const line = [];
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const p = easeInOutCubic(t);
          const width = TRAVEL_WIDTH_START + (TRAVEL_WIDTH_END - TRAVEL_WIDTH_START) * p;
          flight.push({ offset: t, transform: placeAt(p, width), opacity: t < 0.85 ? 1 : 1 - (t - 0.85) / 0.15 });
          line.push({ offset: t, strokeDashoffset: 1 - p });
        }
        anims.push(ghost.animate(flight, { duration: TRAVEL_MS, fill: "forwards" }));
        anims.push(reveal.animate(line, { duration: TRAVEL_MS, fill: "forwards" }));
        setTraveling(true);
      };
    });

    return () => {
      cancelAnimationFrame(raf);
      anims.forEach((a) => {
        a.onfinish = null;
        a.cancel();
      });
    };
  }, [from]);

  return (
    <div className="app-shell sent">
      <div className={`sky ${traveling ? "is-traveling" : ""}`}>
        <StitchMoon fraction={moon.fraction} size={150} cell={5} />
        <svg className="trail" viewBox="0 0 300 260" aria-hidden="true" ref={trailRef}>
          <defs>
            <mask id="trail-mask">
              <path d={TRAIL} pathLength="1" className="trail-reveal" ref={revealRef} />
            </mask>
          </defs>
          <path d={TRAIL} className="trail-dots" mask="url(#trail-mask)" />
        </svg>
      </div>

      <div className="sent-copy stagger">
        <h2 className="display">On its way.</h2>
        <dl className="readout">
          <dt>To</dt>
          <dd>{recipient?.name}</dd>
          <dt>Sealed</dt>
          <dd>{formatShortDateTime(new Date())}</dd>
          <dt>Under</dt>
          <dd>{currentPhase.name}</dd>
          <dt>Opens</dt>
          <dd>When they capture their moon</dd>
        </dl>
        <button className="btn btn--line btn--block" onClick={onDone}>
          Back home
        </button>
      </div>

      {from && (
        <div
          ref={ghostRef}
          className="ghost-envelope"
          style={{ left: from.left, top: from.top, width: from.width, height: from.height }}
          aria-hidden="true"
        >
          <div className="envelope-back" />
          <div className="envelope-front" />
          <div className="envelope-flap" />
          <div className="envelope-seal">
            <WaxSeal />
          </div>
        </div>
      )}
    </div>
  );
};

/** ---------------------------
 *  Opened-letter stories: shown to the sender on login, once per opened letter
 *  --------------------------*/

const HOLD_TO_PAUSE_MS = 220;

const seenOpenedKey = (name) => `mooncode_seen_opened:${name}`;

function readSeenOpened(name) {
  try {
    return new Set(JSON.parse(localStorage.getItem(seenOpenedKey(name)) || "[]"));
  } catch {
    return new Set();
  }
}

function markOpenedSeen(name, id) {
  try {
    const seen = readSeenOpened(name);
    seen.add(id);
    localStorage.setItem(seenOpenedKey(name), JSON.stringify([...seen]));
  } catch {
    // storage unavailable — the story may show again next time
  }
}

const cityOf = (location) => (location ? location.split(",")[0] : "");

const OpenedStories = ({ items, onSeen, onClose, onArchive }) => {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const pressStart = useRef(0);
  const onSeenRef = useRef(onSeen);
  const msg = items[index];
  const isLast = index === items.length - 1;

  useEffect(() => {
    onSeenRef.current = onSeen;
  });

  useEffect(() => {
    onSeenRef.current(msg.id);
  }, [msg.id]);

  const next = () => (isLast ? onClose() : setIndex((i) => i + 1));
  const prev = () => setIndex((i) => Math.max(0, i - 1));

  const nextRef = useRef(next);
  const prevRef = useRef(prev);
  const closeRef = useRef(onClose);
  useEffect(() => {
    nextRef.current = next;
    prevRef.current = prev;
    closeRef.current = onClose;
  });

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") closeRef.current();
      if (e.key === "ArrowRight") nextRef.current();
      if (e.key === "ArrowLeft") prevRef.current();
    };
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, []);

  const tapProps = (action) => ({
    onPointerDown: () => {
      pressStart.current = Date.now();
      setPaused(true);
    },
    onPointerUp: () => setPaused(false),
    onPointerLeave: () => setPaused(false),
    onClick: () => {
      // a long press only pauses; a quick tap moves between stories
      if (Date.now() - pressStart.current < HOLD_TO_PAUSE_MS) action();
    },
  });

  const sendLocation = msg.sendPhoto?.location;
  const receiveLocation = msg.receivePhoto?.location;
  const distance = getDistanceMiles(sendLocation, receiveLocation, msg.sendPhoto?.coords, msg.receivePhoto?.coords);

  return (
    <div className="stories" role="dialog" aria-modal="true" aria-label="Your letters were opened">
      <button className="stories-tap stories-tap--prev" aria-label="Previous" {...tapProps(prev)} />
      <button className="stories-tap stories-tap--next" aria-label="Next" {...tapProps(next)} />

      <div className="stories-top">
        <div className="stories-bars">
          {items.map((m, i) => (
            <span key={m.id} className="stories-bar">
              <i
                className={i < index ? "is-done" : i === index ? "is-active" : ""}
                style={i === index ? { animationPlayState: paused ? "paused" : "running" } : undefined}
                onAnimationEnd={i === index ? next : undefined}
              />
            </span>
          ))}
        </div>
        <div className="stories-head">
          <span className="mono-label">
            Letter opened{items.length > 1 ? ` · ${pad2(index + 1)} / ${pad2(items.length)}` : ""}
          </span>
          <button className="stories-close" onClick={onClose} aria-label="Close">
            <IconClose />
          </button>
        </div>
      </div>

      <div className="stories-body" key={msg.id}>
        <h2 className="display">
          {msg.to} opened <em>your letter.</em>
        </h2>

        <div className="story-moons">
          <figure>
            <div className="story-photo">
              {msg.sendPhoto?.dataUrl && <img src={msg.sendPhoto.dataUrl} alt="Your moon" />}
            </div>
            <figcaption>
              <span className="story-name">You</span>
              <span className="mono-label">{cityOf(sendLocation) || "Your moon"}</span>
            </figcaption>
          </figure>

          <div className="story-link">
            <span className="mono-label">{distance ? `${distance.toLocaleString("en-US")} mi` : "↔"}</span>
          </div>

          <figure>
            <div className="story-photo">
              {msg.receivePhoto?.dataUrl && <img src={msg.receivePhoto.dataUrl} alt={`${msg.to}'s moon`} />}
            </div>
            <figcaption>
              <span className="story-name">{msg.to}</span>
              <span className="mono-label">{cityOf(receiveLocation) || "Their moon"}</span>
            </figcaption>
          </figure>
        </div>

        <dl className="readout story-readout">
          <dt>Sealed</dt>
          <dd>{formatShortDateTime(new Date(msg.sentAt))}</dd>
          <dt>Opened</dt>
          <dd>{msg.receiveAt ? formatShortDateTime(new Date(msg.receiveAt)) : "—"}</dd>
        </dl>
      </div>

      <div className="stories-foot">
        {isLast ? (
          <button className="btn btn--light btn--block" onClick={onArchive}>
            See archive
          </button>
        ) : (
          <span className="mono-label">Tap for next</span>
        )}
      </div>
    </div>
  );
};

const PRINT_LINES = [92, 78, 88, 64, 0, 90, 84, 72, 86, 40, 0, 52];

const PrintingScreen = ({ message, onComplete }) => {
  const [progress, setProgress] = useState(0);
  const onCompleteRef = useRef(onComplete);
  useEffect(() => {
    onCompleteRef.current = onComplete;
  });

  useEffect(() => {
    const start = Date.now();
    const tick = setInterval(() => {
      setProgress(Math.min(100, Math.round(((Date.now() - start) / PRINT_DURATION_MS) * 100)));
    }, 80);
    const timer = setTimeout(() => onCompleteRef.current(), PRINT_DURATION_MS + 500);
    return () => {
      clearInterval(tick);
      clearTimeout(timer);
    };
  }, []);

  return (
    <div className="app-shell printing">
      <div className="printer" aria-hidden="true">
        <div className="printer-body">
          <i className="printer-light" />
          <i className="printer-slot" />
        </div>
        <div className="printer-out">
          <div className="print-sheet">
            <p className="mono-label">From {message?.from}</p>
            {PRINT_LINES.map((w, i) => (
              <i key={i} className="print-line" style={{ width: `${w}%` }} />
            ))}
          </div>
        </div>
      </div>

      <div className="printing-copy">
        <h2 className="display">Printing your letter</h2>
        <p className="field-hint">The moon printer is bringing it to paper.</p>
        <div className="progress">
          <span className="progress-bar" style={{ transform: `scaleX(${progress / 100})` }} />
        </div>
        <p className="mono-label progress-label">
          <span>From {message?.from}</span>
          <span>{pad2(progress)}%</span>
        </p>
      </div>
    </div>
  );
};

const GalleryScreen = ({ messages }) => {
  const galleryItems = messages
    .filter((msg) => msg.receivePhoto)
    .sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt));

  return (
    <div className="app-shell app-shell--nav">
      <header className="archive-head">
        <p className="mono-label">
          Archive · {pad2(galleryItems.length)} {galleryItems.length === 1 ? "letter" : "letters"}
        </p>
        <h1 className="display display--fit">
          Two moons, <em>one letter.</em>
        </h1>
      </header>

      {galleryItems.length === 0 ? (
        <p className="empty">When a letter is opened, both moons will rest here.</p>
      ) : (
        galleryItems.map((msg, i) => {
          const sendLocation = msg.sendPhoto?.location;
          const receiveLocation = msg.receivePhoto?.location;

          // Your send/receive coords in this app are already objects with lat/lon
          const distance = getDistanceMiles(
            sendLocation,
            receiveLocation,
            msg.sendPhoto?.coords,
            msg.receivePhoto?.coords
          );

          const locationLine =
            sendLocation && receiveLocation
              ? `${sendLocation} ↔ ${receiveLocation}`
              : sendLocation || receiveLocation || "Location unavailable";

          const senderName = msg.rawSender || msg.from;
          const receiverName = msg.rawRecipient || msg.to;

          return (
            <article key={msg.id} className="pair" style={{ animationDelay: `${i * 80}ms` }}>
              <header className="pair-head mono-label">
                <span>No. {pad2(galleryItems.length - i)}</span>
                <span>{formatShortDateTime(new Date(msg.sentAt))}</span>
              </header>

              <div className="pair-moons">
                <figure>
                  <div className="pair-photo">
                    {msg.sendPhoto?.dataUrl && <img src={msg.sendPhoto.dataUrl} alt="Sender's moon" />}
                  </div>
                  <figcaption>
                    <span className="pair-name">{senderName}</span>
                    <span className="mono-label">Sent {formatDayStamp(new Date(msg.sentAt))}</span>
                  </figcaption>
                </figure>

                <div className="pair-link">
                  <span className="mono-label">
                    {distance ? `${distance.toLocaleString("en-US")} mi` : "—"}
                  </span>
                </div>

                <figure>
                  <div className="pair-photo">
                    {msg.receivePhoto?.dataUrl && (
                      <img src={msg.receivePhoto.dataUrl} alt="Recipient's moon" />
                    )}
                  </div>
                  <figcaption>
                    <span className="pair-name">{receiverName}</span>
                    <span className="mono-label">
                      {msg.receiveAt ? `Opened ${formatDayStamp(new Date(msg.receiveAt))}` : "Not yet opened"}
                    </span>
                  </figcaption>
                </figure>
              </div>

              <p className="pair-route">{locationLine}</p>
            </article>
          );
        })
      )}
    </div>
  );
};

// Only offer cities: capitals and regional seats, or any populated place of a real town's size.
// Drops landmarks (zoos, airports, parks), neighbourhoods and tiny villages.
const CITY_SEAT_CODES = new Set(["PPLC", "PPLA", "PPLA2", "PPLG"]);
const CITY_MIN_POPULATION = 10000;

function isCityResult(item) {
  const code = item.feature_code || "";
  if (CITY_SEAT_CODES.has(code)) return true;
  return ["PPL", "PPLA3", "PPLA4"].includes(code) && (item.population || 0) >= CITY_MIN_POPULATION;
}

/** ---------------------------
 *  Main App
 *  --------------------------*/

// Sign-in lasts for the browser session only: a refresh keeps you in, reopening the app starts at onboarding
try {
  localStorage.removeItem("mooncode_user");
  localStorage.removeItem("mooncode_route");
} catch {
  // storage unavailable (private mode)
}

const MoonCodeApp = () => {
  const [userData, setUserData] = useState(() => {
    try {
      const stored = JSON.parse(sessionStorage.getItem("mooncode_user") || "{}");
      return {
        name: stored.name || "",
        location: stored.location || "",
        locationData: stored.locationData || null,
      };
    } catch {
      return { name: "", location: "", locationData: null };
    }
  });

  const [route, setRoute] = useState(() => {
    try {
      const storedUser = JSON.parse(sessionStorage.getItem("mooncode_user") || "{}");
      const storedRoute = sessionStorage.getItem("mooncode_route");
      if (storedUser?.name) {
        if (storedRoute && storedRoute !== "onboarding") return storedRoute;
        return "inbox";
      }
    } catch {}
    return "onboarding";
  });

  const [messages, setMessages] = useState([]);
  const [activeMessage, setActiveMessage] = useState(null);

  const [sendPhoto, setSendPhoto] = useState(null);
  const [recipient, setRecipient] = useState(null);
  const [recipientDraft, setRecipientDraft] = useState("");
  // where the sealed envelope sat on the letter screen, so the next screen can pick it up from there
  const [sealedFrom, setSealedFrom] = useState(null);
  // sent letters opened since the sender last looked — shown once as stories after login
  const [openedStories, setOpenedStories] = useState(null);
  const [messageText, setMessageText] = useState("");

  const [locationQuery, setLocationQuery] = useState(userData.location || "");
  const [locationSuggestions, setLocationSuggestions] = useState([]);
  const [locationLoading, setLocationLoading] = useState(false);

  const [currentPhase, setCurrentPhase] = useState(MOON_PHASES[0]);
  const [moonPhaseLoading, setMoonPhaseLoading] = useState(true);
  const [moon, setMoon] = useState(() => getMoonInfo(new Date()));

  // Fetch universal moon phase from API
  useEffect(() => {
    let isMounted = true;

    async function fetchMoonPhase() {
      setMoonPhaseLoading(true);

      try {
        const timestamp = Math.floor(Date.now() / 1000);
        const response = await fetch(`https://api.farmsense.net/v1/moonphases/?d=${timestamp}`);

        if (!response.ok) throw new Error("Moon phase API request failed");

        const data = await response.json();
        if (!isMounted) return;

        if (data && data.length > 0) {
          const moonData = data[0];
          const phaseName = moonData.Phase;

          const phaseMapping = {
            "New Moon": "New Moon",
            "Waxing Crescent": "Waxing Crescent",
            "First Quarter": "First Quarter",
            "Waxing Gibbous": "Waxing Gibbous",
            "Full Moon": "Full Moon",
            "Waning Gibbous": "Waning Gibbous",
            "Last Quarter": "Last Quarter",
            "Third Quarter": "Last Quarter",
            "Waning Crescent": "Waning Crescent",
          };

          const mappedPhaseName = phaseMapping[phaseName] || phaseName;
          const phase = MOON_PHASES.find((p) => p.name === mappedPhaseName);

          if (phase) {
            setCurrentPhase(phase);
          } else {
            setCurrentPhase(getMoonPhaseLocal(new Date()));
          }
        } else {
          throw new Error("No moon phase data returned");
        }
      } catch (error) {
        console.error("Failed to fetch moon phase from API:", error);
        if (isMounted) setCurrentPhase(getMoonPhaseLocal(new Date()));
      } finally {
        if (isMounted) {
          setMoon(getMoonInfo(new Date()));
          setMoonPhaseLoading(false);
        }
      }
    }

    fetchMoonPhase();
    const interval = setInterval(fetchMoonPhase, 60 * 60 * 1000);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  const viewerName = userData.name?.trim() || "";
  const lockedCounterparty = getLockedCounterparty(viewerName);

  // Force message text when entering compose for exhibition users
  useEffect(() => {
    if (route !== "compose") return;
    if (isExhibitionUser(viewerName)) setMessageText(EXHIBITION_MESSAGE);
  }, [route, viewerName]);

  const sortedMessages = useMemo(
    () => [...messages].sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt)),
    [messages]
  );

  const updateUserData = (field, value) => setUserData((p) => ({ ...p, [field]: value }));

  const handleLocationInput = (value) => {
    setLocationQuery(value);
    if (value !== userData.location) {
      setUserData((prev) => ({ ...prev, location: "", locationData: null }));
    }
  };

  const handleSelectLocation = (option) => {
    setUserData((prev) => ({
      ...prev,
      location: option.label,
      locationData: {
        label: option.label,
        timezone: option.timezone,
        lat: option.lat,
        lon: option.lon,
      },
    }));
    setLocationQuery(option.label);
    setLocationSuggestions([]);
  };

  useEffect(() => {
    sessionStorage.setItem("mooncode_user", JSON.stringify(userData));
  }, [userData]);

  useEffect(() => {
    if (route) sessionStorage.setItem("mooncode_route", route);
    // each screen starts at the top so the nav and browser chrome don't jump between tabs
    window.scrollTo(0, 0);
  }, [route]);

  useEffect(() => {
    setLocationQuery(userData.location || "");
  }, [userData.location]);

  useEffect(() => {
    const query = locationQuery.trim();
    // nothing to search once the text is the city that was just picked
    if (query.length < 2 || query === userData.location) {
      setLocationSuggestions([]);
      setLocationLoading(false);
      return;
    }

    const controller = new AbortController();
    setLocationLoading(true);

    const timer = setTimeout(async () => {
      try {
        const response = await fetch(
          `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
            query
          )}&count=30&language=en&format=json`,
          { signal: controller.signal }
        );
        const data = await response.json();
        const results = (data?.results || []).filter(isCityResult);
        const seen = new Set();
        const mapped = [];
        for (const item of results) {
          const region = item.admin1 && item.admin1 !== item.name ? `, ${item.admin1}` : "";
          const label = `${item.name}${region}${item.country ? `, ${item.country}` : ""}`;
          if (seen.has(label)) continue;
          seen.add(label);
          mapped.push({ label, timezone: item.timezone, lat: item.latitude, lon: item.longitude });
        }
        setLocationSuggestions(mapped.slice(0, 6));
      } catch (e) {
        if (e.name !== "AbortError") setLocationSuggestions([]);
      } finally {
        setLocationLoading(false);
      }
    }, 300);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [locationQuery, userData.location]);

  // Load + realtime subscribe
  useEffect(() => {
    const viewer = userData.name?.trim();
    if (!viewer) return;

    let isMounted = true;

    fetchMessagesForUser(viewer)
      .then((rows) => {
        if (!isMounted) return;
        const mapped = rows.map((r) => mapRowToMessage(r, viewer));
        setMessages(mapped);
        const seen = readSeenOpened(viewer);
        const opened = mapped
          .filter((m) => m.from === "You" && m.receivePhoto && !seen.has(m.id))
          .sort((a, b) => new Date(a.receiveAt) - new Date(b.receiveAt));
        setOpenedStories(opened.length ? { viewer, items: opened } : null);
      })
      .catch((err) => console.error("fetchMessagesForUser", err));

    const channel = supabase
      .channel(`messages-${viewer}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, (payload) => {
        const row = payload.new;
        if (!row) return;
        if (row.sender !== viewer && row.recipient !== viewer) return;

        const mapped = mapRowToMessage(row, viewer);

        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === mapped.id);
          if (idx === -1) return [mapped, ...prev];
          const next = [...prev];
          next[idx] = mapped;
          return next;
        });
      })
      .subscribe();

    return () => {
      isMounted = false;
      supabase.removeChannel(channel);
    };
  }, [userData.name]);

  const handleStartSend = () => {
    setRecipient(null);
    setRecipientDraft("");
    setRoute("sendCapture");
  };

  const handleSelectRecipient = (contact) => {
    // Exhibition users: force counterparty
    const forced = lockedCounterparty ? { name: lockedCounterparty } : contact;
    setRecipient(forced);
    setRecipientDraft(forced?.name || "");
    setRoute("compose");
  };

  const handleSendMessage = async () => {
    const sender = userData.name.trim();
    if (!sender) {
      alert("Enter your name first.");
      setRoute("onboarding");
      return false;
    }

    const forcedRecipient = getLockedCounterparty(sender);
    const recipientName = forcedRecipient ? forcedRecipient : recipient?.name?.trim();
    if (!recipientName) return false;

    const bodyText = isExhibitionUser(sender)
      ? EXHIBITION_MESSAGE
      : messageText.trim() || "A message carried by moonlight.";

    try {
      const row = await insertMessage({
        sender,
        recipient: recipientName,
        body: bodyText,
        sendPhoto,
      });

      const mapped = mapRowToMessage(row, sender);
      setMessages((prev) => [mapped, ...prev]);
      setActiveMessage(mapped);
      return true;
    } catch (e) {
      showSupabaseError(e, "Failed to send message. Check RLS policies.");
      return false;
    }
  };

  const handleMessageSentComplete = () => {
    setSealedFrom(null);
    setMessageText("");
    setRecipient(null);
    setSendPhoto(null);
    setRoute("inbox");
  };

  const handleOpenMessage = (msg) => {
    if (!msg) return;
    setActiveMessage(msg);
    if (msg.locked || !msg.receivePhoto) {
      setRoute("unlockCapture");
    } else {
      setRoute("printing");
    }
  };

  const handlePrintingComplete = () => setRoute("inbox");

  const showNav = ["inbox", "gallery"].includes(route);
  const isNight = route === "sendCapture" || route === "unlockCapture";

  return (
    <div className={`mooncode-app ${isNight ? "is-night" : ""}`}>
      {route === "onboarding" && (
        <OnboardingScreen
          userData={userData}
          onUpdate={updateUserData}
          locationQuery={locationQuery}
          locationSuggestions={locationSuggestions}
          locationLoading={locationLoading}
          onLocationChange={handleLocationInput}
          onSelectLocation={handleSelectLocation}
          onBegin={() => setRoute("inbox")}
          currentPhase={currentPhase}
          moon={moon}
        />
      )}

      {route === "inbox" && (
        <InboxScreen
          userData={userData}
          messages={sortedMessages}
          currentPhase={currentPhase}
          moon={moon}
          moonPhaseLoading={moonPhaseLoading}
          onOpen={handleOpenMessage}
          onLogout={() => {
            sessionStorage.removeItem("mooncode_user");
            sessionStorage.removeItem("mooncode_route");
            setUserData({ name: "", location: "", locationData: null });
            setLocationQuery("");
            setLocationSuggestions([]);
            setRoute("onboarding");
          }}
        />
      )}

      {route === "sendCapture" && (
        <MoonCameraCapture
          title="Capture your moon"
          subtitle="Seal your letter with tonight's light"
          step={1}
          locationLabel={userData.location}
          locationCoords={userData.locationData}
          onBack={() => setRoute("inbox")}
          onVerifiedMoon={(capture) => {
            setSendPhoto(capture);
            setRoute("selectRecipient");
          }}
        />
      )}

      {route === "selectRecipient" && (
        <SelectRecipientScreen
          defaultValue={recipientDraft}
          viewerName={viewerName}
          onSelect={handleSelectRecipient}
          onBack={() => setRoute("sendCapture")}
        />
      )}

      {route === "compose" && (
        <ComposeLetterScreen
          recipient={recipient}
          message={messageText}
          onChange={setMessageText}
          onSend={handleSendMessage}
          onSealed={(envelopeRect) => {
            setSealedFrom(envelopeRect);
            setRoute("messageSent");
          }}
          onBack={() => setRoute("selectRecipient")}
          currentPhase={currentPhase}
          viewerName={viewerName}
        />
      )}

      {route === "messageSent" && (
        <MessageSentScreen
          from={sealedFrom}
          recipient={recipient}
          currentPhase={currentPhase}
          moon={moon}
          onDone={handleMessageSentComplete}
        />
      )}

      {route === "unlockCapture" && (
        <MoonCameraCapture
          title="Capture to unlock"
          subtitle="Your moon will reveal this letter"
          locationLabel={userData.location}
          locationCoords={userData.locationData}
          onBack={() => setRoute("inbox")}
          onVerifiedMoon={(capture) => {
            (async () => {
              try {
                const row = await unlockMessage({
                  id: activeMessage.id,
                  receivePhoto: capture,
                });

                const mapped = mapRowToMessage(row, userData.name || "You");
                setActiveMessage(mapped);
                setMessages((prev) => prev.map((m) => (m.id === mapped.id ? mapped : m)));
                setRoute("printing");
              } catch (e) {
                showSupabaseError(e, "Failed to unlock message (check Supabase + RLS).");
              }
            })();
          }}
        />
      )}

      {route === "printing" && (
        <PrintingScreen message={activeMessage} onComplete={handlePrintingComplete} />
      )}

      {route === "gallery" && <GalleryScreen messages={messages} />}

      {showNav && (
        <BottomNav
          current={route}
          onSelect={setRoute}
          onSend={handleStartSend}
        />
      )}

      {route === "inbox" && openedStories?.viewer === viewerName && (
        <OpenedStories
          items={openedStories.items}
          onSeen={(id) => markOpenedSeen(viewerName, id)}
          onClose={() => setOpenedStories(null)}
          onArchive={() => {
            setOpenedStories(null);
            setRoute("gallery");
          }}
        />
      )}
    </div>
  );
};

export default MoonCodeApp;
