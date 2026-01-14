import React, { useEffect, useMemo, useState, useRef } from "react";
import "./index.css";
import { supabase } from "./supabaseClient";

// Import moon phase images from assets
import lastQuarterImg from "./assets/last_quarter.png";
import waningCrescentImg from "./assets/waning_crescent.png";

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
            width: { ideal: 1280 },
            height: { ideal: 720 },
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
    setResultText("Analyzing image...");

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
        setResultText(
          `✦ Moon verified! (${Math.round(moonProb * 100)}% confidence)`
        );

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
        setResultText(
          `Not a moon (${Math.round(moonProb * 100)}% moon, ${Math.round(
            (notMoonPred?.probability || 0) * 100
          )}% not moon). Try pointing at the moon!`
        );
      }
    } catch (e) {
      console.error("❌ Verification error:", e);
      setResultText(`Verification failed: ${e.message}`);
    } finally {
      setVerifying(false);
    }
  };

  // Render
  const hasError = cameraError || modelError;
  const isReady = !modelLoading && cameraReady && !hasError;

  return (
    <div className="app-shell">
      <div className="capture-content">
        {onBack && (
          <button onClick={onBack} className="back-btn">
            ← Back
          </button>
        )}

        <div className="capture-text">
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>

        {/* Error states */}
        {modelError && (
          <div className="empty-state" style={{ color: "#ff6b6b" }}>
            <p>⚠️ Model Error</p>
            <p style={{ fontSize: 12, opacity: 0.8 }}>{modelError}</p>
          </div>
        )}

        {cameraError && (
          <div className="empty-state" style={{ color: "#ff6b6b" }}>
            <p>📷 Camera Error</p>
            <p style={{ fontSize: 12, opacity: 0.8 }}>{cameraError}</p>
          </div>
        )}

        {/* Camera / captured image */}
        {!hasError && (
          <div className="capture-frame" style={{ width: "100%", maxWidth: 420 }}>
            <div className="capture-inner" style={{ padding: 0, position: "relative" }}>
              {!capturedDataUrl ? (
                <>
                  <video
                    ref={videoRef}
                    playsInline
                    muted
                    autoPlay
                    style={{
                      width: "100%",
                      borderRadius: 16,
                      background: "#0a0a0f",
                      display: "block",
                    }}
                  />
                  {!cameraReady && (
                    <div
                      style={{
                        position: "absolute",
                        top: "50%",
                        left: "50%",
                        transform: "translate(-50%, -50%)",
                        color: "#888",
                      }}
                    >
                      Starting camera...
                    </div>
                  )}
                </>
              ) : (
                <img
                  src={capturedDataUrl}
                  alt="Captured"
                  style={{ width: "100%", borderRadius: 16, display: "block" }}
                />
              )}
              <canvas ref={canvasRef} style={{ display: "none" }} />
            </div>
          </div>
        )}

        {/* Loading indicator */}
        {modelLoading && !hasError && (
          <p className="capture-instruction">Loading moon detection model…</p>
        )}

        {/* Controls */}
        {!hasError && (
          <>
            {!capturedDataUrl ? (
              <button
                onClick={takePhoto}
                className="btn-capture"
                disabled={!isReady}
                title={isReady ? "Take photo" : "Waiting for camera and model..."}
              >
                <span className="capture-circle" />
              </button>
            ) : (
              <div style={{ display: "flex", gap: 12, width: "100%", maxWidth: 420 }}>
                <button onClick={retake} className="btn-send" style={{ flex: 1 }}>
                  Retake
                </button>
                <button
                  onClick={verifyMoon}
                  className="btn-send"
                  style={{ flex: 1 }}
                  disabled={verifying || modelLoading}
                >
                  {verifying ? "Checking…" : "Verify Moon"}
                </button>
              </div>
            )}

            {resultText && (
              <div
                className={`capture-note ${
                  resultText.includes("verified")
                    ? "capture-note--success"
                    : resultText.includes("Analyzing")
                    ? "capture-note--neutral"
                    : "capture-note--warning"
                }`}
              >
                {resultText}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** ---------------------------
 *  Moon phase utilities
 *  --------------------------*/

const INITIAL_CONTACTS = [];

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
      "This is the quiet-start phase—blank page energy. Write the letter you’ve been avoiding because it would make things real. Begin with: “I’ve been meaning to tell you…” Focus on intention, honesty, and what you want to grow between you. Keep it simple, sincere, and unpolished.",
    image: null,
  },
  {
    name: "Waxing Crescent",
    meaning: "intentions",
    personalMessage:
      "Hope is showing up in small, stubborn ways. Write to someone you miss, but keep it gentle—no dramatic plot twists. Share one specific memory, one small update about your life, and one wish for them. Tone: tender, curious, a little shy. Let the letter feel like leaning closer, not lunging.",
    image: null,
  },
  {
    name: "First Quarter",
    meaning: "decisions",
    personalMessage:
      "This phase is all nerve and momentum—half sure, half terrified. Write the letter that makes a decision: an apology, a boundary, a confession, a yes, a no. Use clear sentences. Name the truth without over-explaining it. If your hands feel shaky, you’re probably writing the right thing.",
    image: null,
  },
  {
    name: "Waxing Gibbous",
    meaning: "refinement",
    personalMessage:
      "You’re close to saying what you mean—this is the edit phase. Write a letter that clarifies: what you appreciate, what you misunderstood, what you’re learning. Add details (a place, a scent, a line they said). The emotion here is earnest effort: you’re trying, on purpose.",
    image: null,
  },
  {
    name: "Full Moon",
    meaning: "culmination",
    personalMessage:
      "Everything’s loud and glowing—feelings have stage lighting. Write the big letter: gratitude, love, awe, pride, grief—whatever has been building. Don’t be cool. Be precise. Tell them what they changed in you. Let the message be brave enough to be seen.",
    image: null,
  },
  {
    name: "Waning Gibbous",
    meaning: "gratitude",
    personalMessage:
      "This is the afterglow phase—soft, reflective, warm. Write a letter that says thank you without turning it into a speech. Mention one thing they did, one way it mattered, and one thing you’re carrying forward. Emotion: appreciation with a little sweetness, like leaving the porch light on.",
    image: null,
  },
  {
    name: "Last Quarter",
    meaning: "release",
    personalMessage:
      "This is the exhale phase—clean cuts, closure, clearing. Write the letter you may never send: to an old version of you, to someone who hurt you, to something you’re done holding. Say what you’re releasing and what you’re keeping. Emotion: relief, honesty, finality with tenderness.",
    image: lastQuarterImg,
  },
  {
    name: "Waning Crescent",
    meaning: "rest",
    personalMessage:
      "Low battery, high intuition. Write a quiet letter—short, gentle, almost like a whisper. Check in with someone who feels safe. Focus on softness: “Here’s what I’m tired of,” “Here’s what I need,” “Here’s what can wait.”",
    image: waningCrescentImg,
  },
];

const MS_PER_HOUR = 1000 * 60 * 60;
const MS_PER_DAY = 1000 * 60 * 60 * 24;
const SYNODIC_MONTH = 29.53058867;
const KNOWN_NEW_MOON = new Date(Date.UTC(2000, 0, 6, 18, 14, 0));

// Fallback local calculation (used if API fails)
const getMoonPhaseLocal = (date) => {
  const daysSince = (date - KNOWN_NEW_MOON) / MS_PER_DAY;
  const ageDays = ((daysSince % SYNODIC_MONTH) + SYNODIC_MONTH) % SYNODIC_MONTH;
  const phaseIndex = Math.floor((ageDays / SYNODIC_MONTH) * 8 + 0.5) % 8;
  return MOON_PHASES[phaseIndex];
};

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

const MoonIcon = ({ phase, size = 48 }) => {
  const phaseIndex = MOON_PHASES.findIndex((p) => p.name === phase?.name) || 0;
  const illumination = [0, 0.15, 0.5, 0.85, 1, 0.85, 0.5, 0.15][phaseIndex];
  const isWaning = phaseIndex > 4;

  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      <circle
        cx="24"
        cy="24"
        r="22"
        fill="#1a1a1a"
        stroke="#3d4f6f"
        strokeWidth="1"
      />
      <defs>
        <clipPath id={`moonClip-${size}`}>
          <circle cx="24" cy="24" r="21" />
        </clipPath>
      </defs>
      <g clipPath={`url(#moonClip-${size})`}>
        {illumination > 0 && (
          <ellipse
            cx={isWaning ? 24 + (1 - illumination) * 21 : 24 - (1 - illumination) * 21}
            cy="24"
            rx={21 * illumination}
            ry="21"
            fill="#e8e4dc"
          />
        )}
      </g>
    </svg>
  );
};

const MoonVisual = ({ phase, size = 64 }) => {
  const phaseData = MOON_PHASES.find((p) => p.name === phase?.name);

  if (phaseData?.image) {
    return (
      <img
        src={phaseData.image}
        alt={phase?.name || "Moon phase"}
        style={{
          width: size,
          height: size,
          objectFit: "contain",
          borderRadius: "50%",
        }}
      />
    );
  }

  return <MoonIcon phase={phase} size={size} />;
};

const BottomNav = ({ current, onSelect, onSend }) => (
  <div className="bottom-nav">
    <div className="nav-shell">
      <button
        className={`nav-item ${current === "inbox" ? "is-active" : ""}`}
        onClick={() => onSelect("inbox")}
      >
        <span className="nav-emoji">🏠</span>
        <span className="nav-label">Home</span>
      </button>

      <button
        className={`nav-compose ${current === "send" ? "is-active" : ""}`}
        onClick={onSend}
        aria-label="Compose"
        title="Compose"
          style={{ transform: "translateY(50px)" }}   // <-- ADD THIS
      >
        <span className="nav-emoji">✍️</span>
      </button>

      <button
        className={`nav-item ${current === "gallery" ? "is-active" : ""}`}
        onClick={() => onSelect("gallery")}
      >
        <span className="nav-emoji">🗂️</span>
        <span className="nav-label">Archive</span>
      </button>
    </div>
  </div>
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
}) => (
  <div className="app-shell">
    <div className="onboarding-content">
      <div className="onboarding-header">
        <div className="logo-circle">
          <MoonIcon phase={MOON_PHASES[4]} size={40} />
        </div>
        <h1 className="logo-text">Mooncode</h1>
        <p className="tagline">Letters sealed by moonlight</p>
      </div>

      <div className="onboarding-form">
        <div className="form-field">
          <label>Your name</label>
          <input
            type="text"
            value={userData.name}
            onChange={(e) => onUpdate("name", e.target.value)}
          />
        </div>

        <div className="form-field">
          <label>Location</label>
          <input
            type="text"
            value={locationQuery}
            onChange={(e) => onLocationChange(e.target.value)}
            onFocus={() => onLocationChange(locationQuery)}
          />
          {locationSuggestions.length > 0 && (
            <div className="location-suggestions">
              {locationSuggestions.map((option) => (
                <button
                  key={`${option.label}-${option.timezone}`}
                  className="location-option"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onSelectLocation(option);
                  }}
                >
                  <span className="location-name">{option.label}</span>
                  <span className="location-meta">{option.timezone}</span>
                </button>
              ))}
            </div>
          )}
          {locationLoading && <p className="location-loading">Searching cities…</p>}
        </div>
      </div>

      <button
        onClick={onBegin}
        className="btn-primary"
        disabled={!userData.name.trim() || !userData.location}
      >
        Enter
      </button>
    </div>
  </div>
);

const InboxScreen = ({
  userData,
  messages,
  currentPhase,
  moonPhaseLoading,
  onOpen,
  onCompose,
  onLogout,
}) => {
  const incoming = messages.filter((msg) => msg.from !== "You");
  const pending = incoming.filter((msg) => (msg.locked || !msg.receivePhoto) && !msg.archived);
  const sent = messages.filter((msg) => msg.from === "You");
  const greeting = getTimeBasedGreeting(userData.locationData?.timezone);

  return (
    <div className="app-shell">
      <div className="inbox-content">
        <header className="inbox-header">
          <div>
            <p className="date-display">{formatFullDate(new Date())}</p>
            <h1 className="greeting">
              {greeting}
              {userData.name ? `, ${userData.name}` : ""}
            </h1>
          </div>
          <button onClick={onLogout} className="btn-ghost">
            Log out
          </button>
        </header>

        <div className="phase-card">
          <div className="phase-visual">
            <MoonVisual phase={currentPhase} size={64} />
          </div>
          <div className="phase-info">
            <p className="phase-name">{moonPhaseLoading ? "Loading..." : currentPhase.name}</p>
            <p className="phase-meaning">A time for {currentPhase.meaning}</p>
          </div>
          <p className="phase-message">{currentPhase.personalMessage}</p>
        </div>

        <section className="message-section">
          <h2 className="section-title">Awaiting your moon</h2>
          {pending.length === 0 ? (
            <div className="empty-state">
              <p>No letters waiting to be unlocked</p>
            </div>
          ) : (
            <div className="message-list">
              {pending.map((msg) => (
                <button key={msg.id} onClick={() => onOpen(msg)} className="message-card">
                  <div className="message-from">
                    <span className="from-label">From</span>
                    <span className="from-name">{msg.from}</span>
                  </div>
                  <span className="unlock-hint">Capture moon to read →</span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="message-section">
          <h2 className="section-title">Sent</h2>
          {sent.length === 0 ? (
            <div className="empty-state">
              <p>No letters sent yet</p>
            </div>
          ) : (
            <div className="message-list">
              {sent.map((msg) => (
                <div key={msg.id} className="message-card message-card--sent">
                  <div className="message-from">
                    <span className="from-label">To</span>
                    <span className="from-name">{msg.to}</span>
                  </div>
                  <span className="sent-status">{msg.receivePhoto ? "Opened" : "Waiting..."}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

/** ---------------------------
 *  Select Recipient (locked for exhibition users)
 *  --------------------------*/

const SelectRecipientScreen = ({
  suggestions,
  onSelect,
  onBack,
  defaultValue = "",
  viewerName = "",
}) => {
  const locked = getLockedCounterparty(viewerName);
  const [name, setName] = useState(locked || defaultValue);

  useEffect(() => {
    if (locked) setName(locked);
  }, [locked]);

  return (
    <div className="app-shell">
      <div className="recipient-content recipient-content--centered">
        <button
          onClick={onBack}
          className="back-btn"
          style={{ margin: "0 auto 18px", display: "block", textAlign: "center" }}
        >
          ← Back
        </button>

        <div className="recipient-header" style={{ textAlign: "center" }}>
          <p className="step-indicator">Step 1 of 2</p>
          <h1>Who will receive this letter?</h1>
        </div>

        <div
          className="form-field"
          style={{ width: "100%", maxWidth: 280, margin: "18px auto 0" }}
        >
          <label style={{ textAlign: "left", display: "block" }}>Recipient name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Type a name…"
            disabled={!!locked}
            style={{
              width: "100%",
              boxSizing: "border-box",
              opacity: locked ? 0.7 : 1,
            }}
          />
        </div>

        <button
          className="btn-send"
          disabled={!name.trim()}
          onClick={() => onSelect({ name: name.trim() })}
          style={{
            width: "100%",
            maxWidth: 280,
            margin: "32px auto 0",
            display: "block",
            boxSizing: "border-box",
          }}
        >
          Continue →
        </button>
      </div>
    </div>
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
  onBack,
  viewerName = "",
}) => {
  const locked = isExhibitionUser(viewerName);

  return (
    <div className="app-shell">
      <div className="letter-content">
        <button onClick={onBack} className="back-btn">
          ← Back
        </button>

        <div className="letter-paper">
          <div className="letter-header">
            <p className="letter-date">{formatFullDate(new Date())}</p>
          </div>

          <div className="letter-recipient">
            <span className="letter-to">To</span>
            <span className="letter-name">{recipient?.name}</span>
          </div>

          <div className="letter-body">
            <textarea
              value={message}
              onChange={(e) => onChange(e.target.value)}
              className="letter-input"
              readOnly={locked}
              style={{ opacity: locked ? 0.85 : 1 }}
            />
          </div>

          <div className="letter-closing">
            <p className="closing-text">Sealed under tonight's moon</p>
          </div>
        </div>

        <button onClick={onSend} className="btn-send" disabled={!message.trim()}>
          Seal & Send
        </button>
      </div>
    </div>
  );
};

const MessageSentScreen = ({ recipient, onDone }) => {
  useEffect(() => {
    const timer = setTimeout(onDone, 3500);
    return () => clearTimeout(timer);
  }, [onDone]);

  return (
    <div className="app-shell">
      <div className="sent-content">
        <div className="sent-text">
          <h2>Letter sent</h2>
          <p>Your message is traveling to {recipient?.name}</p>
          <p className="sent-subtitle">They'll read it under their moon</p>
        </div>
      </div>
    </div>
  );
};

const PrintingScreen = ({ message, onComplete }) => {
  useEffect(() => {
    const timer = setTimeout(onComplete, 2000);
    return () => clearTimeout(timer);
  }, [onComplete]);

  return (
    <div className="app-shell">
      <div className="printing-content">
        <div className="printing-text">
          <h2>Printing your letter</h2>
          <p>Your moon printer is bringing it to paper...</p>
          <p style={{ marginTop: 12, opacity: 0.7, fontSize: 12 }}>From {message?.from}</p>
        </div>
      </div>
    </div>
  );
};

const GalleryScreen = ({ messages }) => {
  const galleryItems = messages
    .filter((msg) => msg.receivePhoto)
    .sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt));

  return (
    <div className="app-shell">
      <div className="gallery-content">
        <header className="gallery-header">
          <h1>Archive</h1>
          <p>Letters exchanged under the moon</p>
        </header>

        {galleryItems.length === 0 ? (
          <div className="empty-state">
            <p>No letters in the archive yet</p>
          </div>
        ) : (
          <div className="gallery-list">
            {galleryItems.map((msg) => {
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
                <div key={msg.id} className="gallery-card">
                  <div className="gallery-from">{locationLine}</div>
                  <p className="gallery-distance">
                    {distance ? `${distance} miles apart` : "Distance unavailable"}
                  </p>

                  <div className="gallery-moons">
                    <div className="gallery-moon">
                      <div className="moon-photo">
                        {msg.sendPhoto?.dataUrl && <img src={msg.sendPhoto.dataUrl} alt="Send moon" />}
                      </div>
                      <div className="moon-meta">
                        <span className="moon-location">{senderName}</span>
                        <span className="moon-date">Sent {formatShortDateTime(new Date(msg.sentAt))}</span>
                      </div>
                    </div>

                    <div className="gallery-connector">↔</div>

                    <div className="gallery-moon">
                      <div className="moon-photo">
                        {msg.receivePhoto?.dataUrl && (
                          <img src={msg.receivePhoto.dataUrl} alt="Receive moon" />
                        )}
                      </div>
                      <div className="moon-meta">
                        <span className="moon-location">{receiverName}</span>
                        <span className="moon-date">
                          {msg.receiveAt
                            ? `Received ${formatShortDateTime(new Date(msg.receiveAt))}`
                            : "Not yet received"}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

/** ---------------------------
 *  Main App
 *  --------------------------*/

const MoonCodeApp = () => {
  const [userData, setUserData] = useState(() => {
    try {
      const stored = JSON.parse(localStorage.getItem("mooncode_user") || "{}");
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
      const storedUser = JSON.parse(localStorage.getItem("mooncode_user") || "{}");
      const storedRoute = localStorage.getItem("mooncode_route");
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
  const [messageText, setMessageText] = useState("");

  const [locationQuery, setLocationQuery] = useState(userData.location || "");
  const [locationSuggestions, setLocationSuggestions] = useState([]);
  const [locationLoading, setLocationLoading] = useState(false);

  const [currentPhase, setCurrentPhase] = useState(MOON_PHASES[0]);
  const [moonPhaseLoading, setMoonPhaseLoading] = useState(true);

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
        if (isMounted) setMoonPhaseLoading(false);
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
    localStorage.setItem("mooncode_user", JSON.stringify(userData));
  }, [userData]);

  useEffect(() => {
    if (route) localStorage.setItem("mooncode_route", route);
  }, [route]);

  useEffect(() => {
    setLocationQuery(userData.location || "");
  }, [userData.location]);

  useEffect(() => {
    const query = locationQuery.trim();
    if (query.length < 2) {
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
          )}&count=6&language=en&format=json`,
          { signal: controller.signal }
        );
        const data = await response.json();
        const results = data?.results || [];
        const mapped = results.map((item) => ({
          label: `${item.name}${item.admin1 ? `, ${item.admin1}` : ""}, ${item.country}`,
          timezone: item.timezone,
          lat: item.latitude,
          lon: item.longitude,
        }));
        setLocationSuggestions(mapped);
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
  }, [locationQuery]);

  // Load + realtime subscribe
  useEffect(() => {
    const viewer = userData.name?.trim();
    if (!viewer) return;

    let isMounted = true;

    fetchMessagesForUser(viewer)
      .then((rows) => {
        if (!isMounted) return;
        setMessages(rows.map((r) => mapRowToMessage(r, viewer)));
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

  const handleStartSend = () => setRoute("sendCapture");

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
      return;
    }

    const forcedRecipient = getLockedCounterparty(sender);
    const recipientName = forcedRecipient ? forcedRecipient : recipient?.name?.trim();
    if (!recipientName) return;

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
      setRoute("messageSent");
    } catch (e) {
      showSupabaseError(e, "Failed to send message. Check RLS policies.");
    }
  };

  const handleMessageSentComplete = () => {
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

  const showNav = ["inbox", "compose", "gallery", "selectRecipient"].includes(route);

  return (
    <div className="mooncode-app">
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
        />
      )}

      {route === "inbox" && (
        <InboxScreen
          userData={userData}
          messages={sortedMessages}
          currentPhase={currentPhase}
          moonPhaseLoading={moonPhaseLoading}
          onOpen={handleOpenMessage}
          onCompose={handleStartSend}
          onLogout={() => {
            localStorage.removeItem("mooncode_user");
            localStorage.removeItem("mooncode_route");
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
          suggestions={INITIAL_CONTACTS}
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
          onBack={() => setRoute("selectRecipient")}
          viewerName={viewerName}
        />
      )}

      {route === "messageSent" && (
        <MessageSentScreen recipient={recipient} onDone={handleMessageSentComplete} />
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
                console.error(e);
                alert("Failed to unlock message (check Supabase + RLS).");
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
          current={route === "compose" || route === "selectRecipient" ? "send" : route}
          onSelect={setRoute}
          onSend={handleStartSend}
        />
      )}
    </div>
  );
};

export default MoonCodeApp;