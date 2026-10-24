import React, { useEffect, useId, useMemo, useState, useRef } from "react";
import "./index.css";
import { supabase } from "./supabaseClient";

import moonMapUrl from "./assets/moon_map.jpg";

/** ---------------------------
 *  Helpers: Supabase I/O
 *  --------------------------*/

async function fetchMessagesForUser(userId) {
  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .or(`sender_id.eq.${userId},recipient_id.eq.${userId}`)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data ?? [];
}

async function insertMessage({ sender, recipient, body, sendPhoto }) {
  const { data, error } = await supabase
    .from("messages")
    .insert({
      sender_id: sender.id,
      recipient_id: recipient.id,
      // names are kept as a snapshot so letters still read well if someone renames
      sender: sender.name,
      recipient: recipient.name,
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

async function markOpenedLetterSeen(id) {
  const { error } = await supabase
    .from("messages")
    .update({ sender_seen_opened_at: new Date().toISOString() })
    .eq("id", id);
  if (error) console.error("markOpenedLetterSeen", error);
}

function mapRowToMessage(row, viewerId) {
  const isSender = row.sender_id === viewerId;

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
    senderSeenOpenedAt: row.sender_seen_opened_at ?? null,
    rawSender: row.sender,
    rawRecipient: row.recipient,
  };
}

function showSupabaseError(e, fallback = "Supabase error") {
  console.error(e);
  alert(describeError(e, fallback));
}

function describeError(e, fallback = "Something went wrong") {
  if (e instanceof TypeError || /failed to fetch|load failed|network/i.test(e?.message || "")) {
    return "Couldn't reach the mailbox. Check your connection — or the Supabase project may be paused.";
  }
  return e?.message || e?.error_description || e?.details || (typeof e === "string" ? e : null) || fallback;
}

/** ---------------------------
 *  Helpers: accounts, friends, cities
 *  --------------------------*/

const HANDLE_PATTERN = /^[a-z0-9_]{3,20}$/;

async function fetchProfile(userId) {
  const { data, error } = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
  if (error) throw error;
  return data;
}

async function isHandleTaken(handle) {
  const { data, error } = await supabase.from("profiles").select("id").eq("handle", handle).maybeSingle();
  if (error) throw error;
  return !!data;
}

async function createProfile({ id, handle, displayName }) {
  const { data, error } = await supabase
    .from("profiles")
    .insert({ id, handle, display_name: displayName })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function fetchLocation(userId) {
  const { data, error } = await supabase.from("profile_locations").select("*").eq("profile_id", userId).maybeSingle();
  if (error) throw error;
  return data;
}

async function saveLocation(userId, city, shareWithFriends) {
  const { data, error } = await supabase
    .from("profile_locations")
    .upsert({
      profile_id: userId,
      city: city.label,
      timezone: city.timezone,
      lat: city.lat,
      lon: city.lon,
      share_with_friends: shareWithFriends,
      updated_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function searchProfiles(query, myId) {
  const q = query.trim().replace(/^@/, "").replace(/[%_,()]/g, "");
  if (q.length < 2) return [];
  const { data, error } = await supabase
    .from("profiles")
    .select("id, handle, display_name")
    .or(`handle.ilike.${q}%,display_name.ilike.%${q}%`)
    .neq("id", myId)
    .limit(8);
  if (error) throw error;
  return data ?? [];
}

async function fetchProfileByHandle(handle) {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, handle, display_name")
    .eq("handle", handle.toLowerCase())
    .maybeSingle();
  if (error) throw error;
  return data;
}

// All friendships involving me, with the other person's profile and (if shared) their city
async function fetchFriendships(myId) {
  const { data, error } = await supabase
    .from("friendships")
    .select(
      "id, status, requester_id, addressee_id, created_at, requester:profiles!friendships_requester_id_fkey(id, handle, display_name), addressee:profiles!friendships_addressee_id_fkey(id, handle, display_name)"
    )
    .or(`requester_id.eq.${myId},addressee_id.eq.${myId}`);
  if (error) throw error;

  const rows = (data ?? []).map((f) => {
    const other = f.requester_id === myId ? f.addressee : f.requester;
    return {
      id: f.id,
      status: f.status,
      incoming: f.addressee_id === myId,
      profile: { id: other.id, handle: other.handle, name: other.display_name },
    };
  });

  const friendIds = rows.filter((r) => r.status === "accepted").map((r) => r.profile.id);
  if (friendIds.length) {
    const { data: locations } = await supabase
      .from("profile_locations")
      .select("profile_id, city, timezone, lat, lon")
      .in("profile_id", friendIds);
    for (const loc of locations ?? []) {
      const row = rows.find((r) => r.profile.id === loc.profile_id);
      if (row) row.location = loc;
    }
  }
  return rows;
}

async function sendFriendRequest(myId, otherId) {
  const { error } = await supabase.from("friendships").insert({ requester_id: myId, addressee_id: otherId });
  // a request between the two already exists — nothing to do
  if (error && error.code !== "23505") throw error;
}

async function acceptFriendRequest(id) {
  const { error } = await supabase
    .from("friendships")
    .update({ status: "accepted", accepted_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

async function removeFriendship(id) {
  const { error } = await supabase.from("friendships").delete().eq("id", id);
  if (error) throw error;
}

const inviteLinkFor = (handle) => `${window.location.origin}${import.meta.env.BASE_URL}?invite=${handle}`;

// Picks up ?invite=handle from the URL once, and keeps it until the visitor has an account
const INVITE_KEY = "mooncode_invite";
function takeInviteFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    const invite = params.get("invite");
    if (invite && HANDLE_PATTERN.test(invite.toLowerCase())) {
      sessionStorage.setItem(INVITE_KEY, invite.toLowerCase());
      params.delete("invite");
      const rest = params.toString();
      window.history.replaceState(null, "", window.location.pathname + (rest ? `?${rest}` : ""));
    }
    return sessionStorage.getItem(INVITE_KEY);
  } catch {
    return null;
  }
}

function clearInvite() {
  try {
    sessionStorage.removeItem(INVITE_KEY);
  } catch {
    // storage unavailable
  }
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

// Per-pixel geometry of the disc, worked out once: where each pixel lands on the moon map, and how
// much sunlight it gets. Spinning only shifts longitude, so a frame is just lookups.
function computeMoonGeometry(map, fraction, px) {
  const theta = 2 * Math.PI * fraction;
  const sun = [Math.sin(theta), 0, -Math.cos(theta)];
  const r = px / 2;
  const lon = new Float32Array(px * px);
  const row = new Int32Array(px * px);
  const shade = new Float32Array(px * px).fill(-1); // -1 = outside the disc

  for (let py = 0; py < px; py++) {
    for (let pxi = 0; pxi < px; pxi++) {
      const x = (pxi + 0.5 - r) / r;
      const y = (py + 0.5 - r) / r;
      const d2 = x * x + y * y;
      if (d2 > 1) continue;
      const z = Math.sqrt(1 - d2);
      const i = py * px + pxi;
      lon[i] = Math.atan2(x, z);
      row[i] = Math.floor((0.5 - Math.asin(-y) / Math.PI) * (map.h - 1)) * map.w;
      // nearly flat-lit until close to the terminator, with a touch of limb darkening so the edge holds
      const mu0 = x * sun[0] + y * sun[1] + z * sun[2];
      const lit = mu0 > 0 ? Math.pow(clamp01(mu0 * 5), 0.6) : 0;
      shade[i] = lit * (0.78 + 0.22 * z);
    }
  }
  return { lon, row, shade };
}

const albedoCache = new WeakMap();
function albedoOf(map) {
  if (!albedoCache.has(map)) albedoCache.set(map, map.gray.map((g) => 0.25 + 0.75 * clamp01((g - 0.3) / 0.45)));
  return albedoCache.get(map);
}

const THRESHOLD = 0.56;
const GRAIN = 0.16;
const TWO_PI = Math.PI * 2;

// Real lunar surface, lit for tonight's phase, run through a threshold: every pixel is ink or paper.
// On load the threshold sweeps up, so the darkest areas ink in first. With `spinnable`, a sideways
// drag turns the moon like a globe; it coasts, then settles back to the face we actually see.
const ThresholdMoon = ({ fraction = 0.5, size = 232, spinnable = false, className = "" }) => {
  const canvasRef = useRef(null);
  const spin = useRef({ rot: 0, vel: 0, dragging: false, lastX: 0, lastT: 0, releasedAt: 0 });
  const kickRef = useRef(() => {});

  useEffect(() => {
    let alive = true;
    let raf = 0;

    loadMoonMap()
      .then((map) => {
        const canvas = canvasRef.current;
        if (!alive || !canvas) return;
        const px = Math.round(size * Math.min(2, window.devicePixelRatio || 1));
        canvas.width = px;
        canvas.height = px;
        const ctx = canvas.getContext("2d");
        const [ir, ig, ib] = (getComputedStyle(canvas).color.match(/\d+/g) || [20, 20, 20]).map(Number);

        const { lon, row, shade } = computeMoonGeometry(map, fraction, px);
        const albedo = albedoOf(map);
        const grain = new Float32Array(shade.length);
        for (let i = 0; i < grain.length; i++) grain[i] = (Math.random() - 0.5) * 2 * GRAIN;

        const image = ctx.createImageData(px, px);
        const data = image.data;
        const uScale = (map.w - 1) / TWO_PI;

        const draw = (level, rot) => {
          for (let i = 0; i < shade.length; i++) {
            const k = i * 4;
            if (shade[i] < 0) {
              data[k + 3] = 0;
              continue;
            }
            let l = lon[i] + rot + Math.PI;
            l -= Math.floor(l / TWO_PI) * TWO_PI;
            const b = shade[i] * albedo[row[i] + Math.floor(l * uScale)];
            if (b + grain[i] < level) {
              data[k] = ir;
              data[k + 1] = ig;
              data[k + 2] = ib;
              data[k + 3] = 255;
            } else {
              data[k + 3] = 0;
            }
          }
          ctx.putImageData(image, 0, 0);
        };

        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const start = performance.now();
        const develop = reduceMotion ? 0 : 1200;
        const state = spin.current;
        let running = false;

        const frame = (now) => {
          const t = develop ? Math.min(1, (now - start) / develop) : 1;
          const level = THRESHOLD * (1 - Math.pow(1 - t, 3));

          let moving = state.dragging;
          if (!state.dragging) {
            if (Math.abs(state.vel) > 0.0004) {
              // coast after a flick
              state.rot += state.vel;
              state.vel *= 0.94;
              state.releasedAt = now;
              moving = true;
            } else if (state.rot !== 0 && now - state.releasedAt > 1200) {
              // then ease back to tonight's face (the nearest whole turn)
              const home = Math.round(state.rot / TWO_PI) * TWO_PI;
              state.rot += (home - state.rot) * 0.06;
              if (Math.abs(home - state.rot) < 0.0008) state.rot = 0;
              moving = true;
            } else if (state.rot !== 0) {
              moving = true; // waiting out the pause before settling
            }
          }

          draw(level, state.rot);
          if (t < 1 || moving) {
            raf = requestAnimationFrame(frame);
          } else {
            running = false;
          }
        };

        kickRef.current = () => {
          if (running || !alive) return;
          running = true;
          raf = requestAnimationFrame(frame);
        };
        kickRef.current();
      })
      .catch((err) => console.error("Moon map failed to load", err));

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      kickRef.current = () => {};
    };
  }, [fraction, size]);

  const radius = () => (canvasRef.current?.getBoundingClientRect().width || size) / 2;

  const dragProps = spinnable
    ? {
        onPointerDown: (e) => {
          const state = spin.current;
          state.dragging = true;
          state.vel = 0;
          state.lastX = e.clientX;
          state.lastT = performance.now();
          e.currentTarget.setPointerCapture(e.pointerId);
          kickRef.current();
        },
        onPointerMove: (e) => {
          const state = spin.current;
          if (!state.dragging) return;
          const now = performance.now();
          // dragging right turns the near side to the right
          const delta = -(e.clientX - state.lastX) / radius();
          state.rot += delta;
          state.vel = delta / Math.max(1, (now - state.lastT) / 16.7);
          state.lastX = e.clientX;
          state.lastT = now;
        },
        onPointerUp: () => {
          spin.current.dragging = false;
          spin.current.releasedAt = performance.now();
        },
        onPointerCancel: () => {
          spin.current.dragging = false;
          spin.current.releasedAt = performance.now();
        },
      }
    : {};

  return (
    <canvas
      ref={canvasRef}
      className={`threshold-moon ${spinnable ? "is-spinnable" : ""} ${className}`}
      style={{ "--moon-size": `${size}px` }}
      aria-hidden="true"
      {...dragProps}
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

const IconFriends = () => (
  <Icon>
    <circle cx="9" cy="8.5" r="3.2" />
    <path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8" />
    <circle cx="16.5" cy="9.5" r="2.5" />
    <path d="M15.6 14.4c2.3.1 4 1.6 4.6 4.1" />
  </Icon>
);

const IconUser = () => (
  <Icon>
    <circle cx="12" cy="8.5" r="3.6" />
    <path d="M5 20c.8-3.6 3.6-5.6 7-5.6s6.2 2 7 5.6" />
  </Icon>
);

const NAV_ITEMS = [
  { route: "inbox", label: "Home", icon: IconHome },
  { route: "friends", label: "Friends", icon: IconFriends },
  null, // the pen sits in the middle
  { route: "gallery", label: "Archive", icon: IconLetter },
  { route: "profile", label: "You", icon: IconUser },
];

const BottomNav = ({ current, onSelect, onSend, badges = {} }) => (
  <nav className="nav" aria-label="Main">
    {NAV_ITEMS.map((item) =>
      item ? (
        <button
          key={item.route}
          className={`nav-item ${current === item.route ? "is-active" : ""}`}
          onClick={() => onSelect(item.route)}
          aria-label={item.label}
        >
          <item.icon />
          {badges[item.route] ? <i className="nav-badge" aria-label="New" /> : null}
        </button>
      ) : (
        <button key="pen" className="nav-compose" onClick={onSend} aria-label="Write a letter" title="Write a letter">
          <IconPen />
        </button>
      )
    )}
  </nav>
);

const Toggle = ({ checked, onChange, label }) => (
  <label className="toggle">
    <span>{label}</span>
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    <i aria-hidden="true" />
  </label>
);

// City search with suggestions plus "Use my location"
const CityField = ({ id, label, value, onChange }) => {
  const [query, setQuery] = useState(value?.label || "");
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState("");
  const { suggestions, loading } = useCitySearch(query, value?.label || "");

  const pick = (city) => {
    setQuery(city.label);
    setError("");
    onChange(city);
  };

  const useMyLocation = async () => {
    setDetecting(true);
    setError("");
    try {
      pick(await detectCurrentCity());
    } catch (e) {
      setError(`${e.message} You can search for your city instead.`);
    } finally {
      setDetecting(false);
    }
  };

  return (
    <div className="field">
      <label htmlFor={id} className="mono-label">
        {label}
      </label>
      <input
        id={id}
        type="text"
        autoComplete="off"
        placeholder="City"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          if (value && e.target.value !== value.label) onChange(null);
        }}
      />
      {suggestions.length > 0 && (
        <div className="suggest">
          {suggestions.map((city) => (
            <button
              type="button"
              key={`${city.label}-${city.timezone}`}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(city);
              }}
            >
              <span>{city.label}</span>
              <small>{city.timezone}</small>
            </button>
          ))}
        </div>
      )}
      {loading && <p className="field-hint">Searching cities…</p>}
      {error && <p className="field-hint field-hint--warn">{error}</p>}
      <button type="button" className="locate" onClick={useMyLocation} disabled={detecting}>
        <IconPin />
        {detecting ? "Finding you…" : "Use my location"}
      </button>
    </div>
  );
};

const IconPin = () => (
  <Icon size={16}>
    <path d="M12 21s-6-5.6-6-11a6 6 0 1 1 12 0c0 5.4-6 11-6 11z" />
    <circle cx="12" cy="10" r="2.2" />
  </Icon>
);

const formatLocalTime = (timezone) => {
  if (!timezone) return "";
  try {
    return new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: timezone });
  } catch {
    return "";
  }
};

const cityName = (label) => (label ? label.split(",")[0] : "");

// Search people by @handle or name and send requests
const FriendFinder = ({ me, friendships, onChanged }) => {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    let alive = true;
    const timer = setTimeout(async () => {
      try {
        const found = await searchProfiles(query, me.id);
        if (alive) setResults(found);
      } catch (e) {
        console.error("searchProfiles", e);
      }
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query, me.id]);

  const statusFor = (id) => friendships.find((f) => f.profile.id === id);

  const add = async (person) => {
    setBusyId(person.id);
    try {
      await sendFriendRequest(me.id, person.id);
      await onChanged();
    } catch (e) {
      showSupabaseError(e, "Couldn't send the request.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="finder">
      <input
        className="finder-input"
        type="search"
        placeholder="Search @handle or name"
        autoComplete="off"
        autoCapitalize="none"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search for friends"
      />
      {query.trim().length >= 2 && (
        <div className="finder-results">
          {results.length === 0 ? (
            <p className="field-hint">No one by that name yet. Send them your invite link.</p>
          ) : (
            results.map((person) => {
              const existing = statusFor(person.id);
              return (
                <div key={person.id} className="person">
                  <span className="person-main">
                    <span className="person-name">{person.display_name}</span>
                    <span className="mono-label">@{person.handle}</span>
                  </span>
                  {existing ? (
                    <span className="mono-label">
                      {existing.status === "accepted" ? "Friends" : existing.incoming ? "Asked you" : "Requested"}
                    </span>
                  ) : (
                    <button className="chip" onClick={() => add(person)} disabled={busyId === person.id}>
                      Add
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
};

const InviteButton = ({ handle }) => {
  const [copied, setCopied] = useState(false);
  const share = async () => {
    const url = inviteLinkFor(handle);
    try {
      if (navigator.share) {
        await navigator.share({ title: "Mooncode", text: "Write to me under the moon.", url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // share sheet dismissed
    }
  };
  return (
    <button type="button" className="btn btn--line btn--block" onClick={share}>
      {copied ? "Link copied" : "Share your invite link"}
    </button>
  );
};

/** ---------------------------
 *  Onboarding: account → name → city → friends → done
 *  --------------------------*/

const SETUP_STEPS = 4;

const OnboardingFlow = ({
  session,
  profile,
  location,
  friendships,
  invite,
  onProfileCreated,
  onLocationSaved,
  onFriendsChanged,
  onFinished,
  currentPhase,
  moon,
}) => {
  const [authStep, setAuthStep] = useState("welcome");
  const [afterFriends, setAfterFriends] = useState(false);

  const step = !session
    ? authStep
    : !profile
    ? "name"
    : !location
    ? "location"
    : afterFriends
    ? "done"
    : "friends";

  return (
    <div className="app-shell onboard" key={step}>
      {step === "welcome" && (
        <WelcomeStep
          moon={moon}
          invite={invite}
          onSignUp={() => setAuthStep("signup")}
          onSignIn={() => setAuthStep("signin")}
        />
      )}
      {(step === "signup" || step === "signin") && (
        <AccountStep
          mode={step}
          onBack={() => setAuthStep("welcome")}
          onSwitch={() => setAuthStep(step === "signup" ? "signin" : "signup")}
        />
      )}
      {step === "name" && <NameStep userId={session.user.id} onCreated={onProfileCreated} />}
      {step === "location" && <LocationStep userId={session.user.id} onSaved={onLocationSaved} />}
      {step === "friends" && (
        <FriendsStep
          me={{ id: profile.id, handle: profile.handle }}
          friendships={friendships}
          onChanged={onFriendsChanged}
          onContinue={() => setAfterFriends(true)}
        />
      )}
      {step === "done" && (
        <DoneStep name={profile.display_name} moon={moon} currentPhase={currentPhase} onEnter={onFinished} />
      )}
    </div>
  );
};

const WelcomeStep = ({ moon, invite, onSignUp, onSignIn }) => (
  <>
    <div className="onboard-hero stagger">
      <ThresholdMoon fraction={moon.fraction} size={200} spinnable />
      <h1 className="display">
        Letters sealed
        <br />
        by <em>moonlight.</em>
      </h1>
      {invite && (
        <p className="field-hint onboard-lede">@{invite} invited you. Write each other letters that open under the moon.</p>
      )}
    </div>

    <div className="onboard-actions stagger">
      <button className="btn btn--ink btn--block" onClick={onSignUp}>
        Create account
      </button>
      <p className="signin-prompt">
        Have an account?{" "}
        <button className="link" onClick={onSignIn}>
          Sign in
        </button>
      </p>
    </div>
  </>
);

const AccountStep = ({ mode, onBack, onSwitch }) => {
  const signUp = mode === "signup";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (signUp) {
        const { data, error: err } = await supabase.auth.signUp({ email: email.trim(), password });
        if (err) throw err;
        // with email confirmation on, there's no session until the link is clicked
        if (!data.session) setNotice("Check your email to confirm your account, then sign in.");
      } else {
        const { error: err } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (err) throw err;
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const resetPassword = async () => {
    if (!email.trim()) {
      setError("Enter your email first.");
      return;
    }
    const { error: err } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}${import.meta.env.BASE_URL}`,
    });
    if (err) setError(describeError(err));
    else setNotice("We sent you a link to set a new password.");
  };

  return (
    <form className="setup" onSubmit={submit}>
      <TopBar onBack={onBack} step={signUp ? 1 : null} total={SETUP_STEPS} />
      <div className="step-body stagger">
        <p className="mono-label">{signUp ? "Account" : "Welcome back"}</p>
        <h1 className="display">{signUp ? "Make your account" : "Sign in"}</h1>
        <div className="field">
          <label htmlFor="mc-email" className="mono-label">
            Email
          </label>
          <input
            id="mc-email"
            type="email"
            autoComplete="email"
            autoCapitalize="none"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <div className="field-label-row">
            <label htmlFor="mc-password" className="mono-label">
              Password
            </label>
            {!signUp && (
              <button type="button" className="mono-label link" onClick={resetPassword}>
                Forgot?
              </button>
            )}
          </div>
          <input
            id="mc-password"
            type="password"
            autoComplete={signUp ? "new-password" : "current-password"}
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {signUp && <p className="field-hint">At least 6 characters.</p>}
        </div>
        {error && (
          <p className="form-alert" role="alert">
            {error === "Invalid login credentials" ? "That email and password don't match an account." : error}
          </p>
        )}
        {notice && <p className="field-hint field-hint--ok">{notice}</p>}
      </div>
      <div className="setup-foot">
        <button type="submit" className="btn btn--ink btn--block" disabled={busy}>
          {busy ? "One moment…" : signUp ? "Continue" : "Sign in"}
        </button>
        <p className="signin-prompt">
          {signUp ? "Have an account? " : "New here? "}
          <button type="button" className="link" onClick={onSwitch}>
            {signUp ? "Sign in" : "Create an account"}
          </button>
        </p>
      </div>
    </form>
  );
};

const suggestHandle = (name) =>
  name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9_]+/g, "")
    .slice(0, 20);

const NameStep = ({ userId, onCreated }) => {
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [handleEdited, setHandleEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const shownHandle = handleEdited ? handle : suggestHandle(name);
  const handleValid = HANDLE_PATTERN.test(shownHandle);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim() || !handleValid) return;
    setBusy(true);
    setError("");
    try {
      if (await isHandleTaken(shownHandle)) {
        setError(`@${shownHandle} is taken. Try another.`);
        return;
      }
      onCreated(await createProfile({ id: userId, handle: shownHandle, displayName: name.trim() }));
    } catch (err) {
      setError(err.code === "23505" ? `@${shownHandle} is taken. Try another.` : describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="setup" onSubmit={submit}>
      <TopBar step={2} total={SETUP_STEPS} />
      <div className="step-body stagger">
        <p className="mono-label">You</p>
        <h1 className="display">What should letters call you?</h1>
        <div className="field">
          <label htmlFor="mc-name" className="mono-label">
            Name
          </label>
          <input
            id="mc-name"
            type="text"
            autoComplete="given-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="mc-handle" className="mono-label">
            Handle — how friends find you
          </label>
          <div className="handle-input">
            <span>@</span>
            <input
              id="mc-handle"
              type="text"
              autoCapitalize="none"
              autoComplete="username"
              value={shownHandle}
              onChange={(e) => {
                setHandleEdited(true);
                setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20));
              }}
            />
          </div>
          <p className="field-hint">3–20 letters, numbers or underscores.</p>
        </div>
        {error && <p className="field-hint field-hint--warn">{error}</p>}
      </div>
      <div className="setup-foot">
        <button type="submit" className="btn btn--ink btn--block" disabled={busy || !name.trim() || !handleValid}>
          {busy ? "Checking…" : "Continue"}
        </button>
      </div>
    </form>
  );
};

const LocationStep = ({ userId, onSaved }) => {
  const [city, setCity] = useState(null);
  const [share, setShare] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    if (!city) return;
    setBusy(true);
    setError("");
    try {
      onSaved(await saveLocation(userId, city, share));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="setup" onSubmit={submit}>
      <TopBar step={3} total={SETUP_STEPS} />
      <div className="step-body stagger">
        <p className="mono-label">Your sky</p>
        <h1 className="display">Where do you watch the moon?</h1>
        <CityField id="mc-city" label="City" value={city} onChange={setCity} />
        <Toggle checked={share} onChange={setShare} label="Let friends see my city" />
        <p className="field-hint">Only your city is saved — never your exact location.</p>
        {error && <p className="field-hint field-hint--warn">{error}</p>}
      </div>
      <div className="setup-foot">
        <button type="submit" className="btn btn--ink btn--block" disabled={busy || !city}>
          {busy ? "Saving…" : "Continue"}
        </button>
      </div>
    </form>
  );
};

const FriendsStep = ({ me, friendships, onChanged, onContinue }) => {
  const pending = friendships.filter((f) => f.status === "pending" && !f.incoming);
  return (
    <div className="setup">
      <TopBar step={4} total={SETUP_STEPS} />
      <div className="step-body step-body--top stagger">
        <p className="mono-label">Friends</p>
        <h1 className="display">Who do you write to?</h1>
        <FriendFinder me={me} friendships={friendships} onChanged={onChanged} />
        {pending.length > 0 && (
          <p className="field-hint field-hint--ok">
            Requested {pending.map((f) => `@${f.profile.handle}`).join(", ")} — they'll show up once they accept.
          </p>
        )}
        <InviteButton handle={me.handle} />
      </div>
      <div className="setup-foot">
        <button className="btn btn--ink btn--block" onClick={onContinue}>
          {pending.length ? "Continue" : "Skip for now"}
        </button>
      </div>
    </div>
  );
};

const DoneStep = ({ name, moon, currentPhase, onEnter }) => (
  <div className="setup setup--done">
    <div className="onboard-hero stagger">
      <ThresholdMoon fraction={moon.fraction} size={200} spinnable />
      <h1 className="display">
        You're all set, <em>{name}.</em>
      </h1>
      <p className="mono-label">
        Tonight · {currentPhase.name} · {Math.round(moon.illumination * 100)}% lit
      </p>
    </div>
    <div className="setup-foot">
      <button className="btn btn--ink btn--block" onClick={onEnter}>
        Enter
      </button>
    </div>
  </div>
);

const SetPasswordScreen = ({ onDone }) => {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    const { error: err } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (err) setError(describeError(err));
    else onDone();
  };
  return (
    <form className="app-shell setup" onSubmit={submit}>
      <div className="step-body stagger">
        <p className="mono-label">Account</p>
        <h1 className="display">Choose a new password</h1>
        <div className="field">
          <label htmlFor="mc-new-password" className="mono-label">
            New password
          </label>
          <input
            id="mc-new-password"
            type="password"
            autoComplete="new-password"
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        {error && <p className="field-hint field-hint--warn">{error}</p>}
      </div>
      <button type="submit" className="btn btn--ink btn--block" disabled={busy}>
        Save password
      </button>
    </form>
  );
};

/** ---------------------------
 *  Friends and profile tabs
 *  --------------------------*/

const FriendsScreen = ({ me, friendships, onChanged, onWrite }) => {
  const [busyId, setBusyId] = useState(null);
  const incoming = friendships.filter((f) => f.status === "pending" && f.incoming);
  const outgoing = friendships.filter((f) => f.status === "pending" && !f.incoming);
  const friends = friendships
    .filter((f) => f.status === "accepted")
    .sort((a, b) => a.profile.name.localeCompare(b.profile.name));

  const act = async (id, fn) => {
    setBusyId(id);
    try {
      await fn(id);
      await onChanged();
    } catch (e) {
      showSupabaseError(e);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="app-shell app-shell--nav">
      <header className="archive-head">
        <h1 className="display display--fit">
          Who you <em>write to.</em>
        </h1>
      </header>

      <FriendFinder me={me} friendships={friendships} onChanged={onChanged} />

      {incoming.length > 0 && (
        <section className="list-section">
          <header className="list-head">
            <h2 className="mono-label">Asking to be friends</h2>
            <span className="mono-label">{pad2(incoming.length)}</span>
          </header>
          {incoming.map((f) => (
            <div key={f.id} className="person person--row">
              <span className="person-main">
                <span className="person-name">{f.profile.name}</span>
                <span className="mono-label">@{f.profile.handle}</span>
              </span>
              <span className="person-actions">
                <button className="chip chip--ghost" disabled={busyId === f.id} onClick={() => act(f.id, removeFriendship)}>
                  Decline
                </button>
                <button className="chip" disabled={busyId === f.id} onClick={() => act(f.id, acceptFriendRequest)}>
                  Accept
                </button>
              </span>
            </div>
          ))}
        </section>
      )}

      <section className="list-section">
        <header className="list-head">
          <h2 className="mono-label">Friends</h2>
          <span className="mono-label">{pad2(friends.length)}</span>
        </header>
        {friends.length === 0 ? (
          <p className="empty">No friends yet. Search above, or send your invite link.</p>
        ) : (
          friends.map((f) => (
            <div key={f.id} className="person person--row">
              <span className="person-main">
                <span className="person-name">{f.profile.name}</span>
                <span className="mono-label">
                  {f.location
                    ? `${cityName(f.location.city)} · ${formatLocalTime(f.location.timezone)}`
                    : `@${f.profile.handle}`}
                </span>
              </span>
              <button className="icon-btn" onClick={() => onWrite(f.profile)} aria-label={`Write to ${f.profile.name}`}>
                <IconPen />
              </button>
            </div>
          ))
        )}
      </section>

      {outgoing.length > 0 && (
        <section className="list-section">
          <header className="list-head">
            <h2 className="mono-label">Waiting on them</h2>
            <span className="mono-label">{pad2(outgoing.length)}</span>
          </header>
          {outgoing.map((f) => (
            <div key={f.id} className="person person--row">
              <span className="person-main">
                <span className="person-name">{f.profile.name}</span>
                <span className="mono-label">@{f.profile.handle}</span>
              </span>
              <button className="chip chip--ghost" disabled={busyId === f.id} onClick={() => act(f.id, removeFriendship)}>
                Cancel
              </button>
            </div>
          ))}
        </section>
      )}

      <div className="list-section">
        <InviteButton handle={me.handle} />
      </div>
    </div>
  );
};

// A round postmark: city across the top, date across the bottom, a crescent in the middle
const Postmark = ({ city, date }) => {
  const id = useId();
  return (
    <svg className="postmark" viewBox="0 0 100 100" aria-hidden="true">
      <defs>
        <path id={`${id}-top`} d="M 18 50 A 32 32 0 0 1 82 50" />
        <path id={`${id}-bottom`} d="M 15 50 A 35 35 0 0 0 85 50" />
        <mask id={`${id}-moon`}>
          <circle cx="50" cy="50" r="9" fill="#fff" />
          <circle cx="54.5" cy="47.5" r="7.8" fill="#000" />
        </mask>
      </defs>
      <circle cx="50" cy="50" r="46" />
      <circle cx="50" cy="50" r="41" strokeDasharray="1.5 2.5" />
      <text>
        <textPath href={`#${id}-top`} startOffset="50%" textAnchor="middle">
          {city.toUpperCase()}
        </textPath>
      </text>
      <text>
        <textPath href={`#${id}-bottom`} startOffset="50%" textAnchor="middle">
          {date.toUpperCase()}
        </textPath>
      </text>
      <circle cx="50" cy="50" r="9" className="postmark-moon" mask={`url(#${id}-moon)`} />
    </svg>
  );
};

const ProfileScreen = ({ profile, location, stats, onLocationSaved, onLogout }) => {
  const [editingCity, setEditingCity] = useState(false);
  const [status, setStatus] = useState("");
  const [copied, setCopied] = useState(false);
  const city = location
    ? { label: location.city, timezone: location.timezone, lat: location.lat, lon: location.lon }
    : null;
  const share = location?.share_with_friends ?? true;
  const since = profile.created_at
    ? new Date(profile.created_at).toLocaleDateString("en-US", { month: "short", year: "numeric" })
    : "";

  // changes save as they're made; a short note confirms it
  const save = async (nextCity, nextShare) => {
    setStatus("Saving…");
    try {
      onLocationSaved(await saveLocation(profile.id, nextCity, nextShare));
      setStatus("Saved");
      setTimeout(() => setStatus(""), 1800);
    } catch (e) {
      setStatus("");
      showSupabaseError(e, "Couldn't save that.");
    }
  };

  const copyHandle = async () => {
    try {
      await navigator.clipboard.writeText(`@${profile.handle}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard unavailable
    }
  };

  return (
    <div className="app-shell app-shell--nav">
      <article className="id-card">
        <Postmark city={cityName(location?.city) || "Mooncode"} date={formatDayStamp(new Date())} />
        <p className="mono-label">Mooncode</p>
        <h1 className="id-name">{profile.display_name}</h1>
        <button className="id-handle" onClick={copyHandle} aria-label={`Copy @${profile.handle}`}>
          @{profile.handle}
          <span className="mono-label">{copied ? "Copied" : "Copy"}</span>
        </button>

        <dl className="readout id-facts">
          <dt>Sky</dt>
          <dd>{cityName(location?.city) || "—"}</dd>
          <dt>Local</dt>
          <dd>{formatLocalTime(location?.timezone) || "—"}</dd>
          {since && (
            <>
              <dt>Since</dt>
              <dd>{since}</dd>
            </>
          )}
        </dl>

        <div className="id-stats">
          <div>
            <span className="id-stat">{stats.sent}</span>
            <span className="mono-label">Sent</span>
          </div>
          <div>
            <span className="id-stat">{stats.received}</span>
            <span className="mono-label">Received</span>
          </div>
          <div>
            <span className="id-stat">{stats.friends}</span>
            <span className="mono-label">Friends</span>
          </div>
        </div>
      </article>

      <section className="settings">
        <header className="list-head">
          <h2 className="mono-label">Settings</h2>
          <span className="mono-label" aria-live="polite">
            {status}
          </span>
        </header>

        {editingCity ? (
          <div className="settings-edit">
            <CityField
              id="mc-profile-city"
              label="Where you watch the moon"
              value={city}
              onChange={(next) => {
                if (!next || next.label === city?.label) return;
                save(next, share);
                setEditingCity(false);
              }}
            />
            <button className="mono-label link" onClick={() => setEditingCity(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button className="settings-row" onClick={() => setEditingCity(true)}>
            <span className="mono-label">Where you watch the moon</span>
            <span className="settings-value">
              {cityName(location?.city) || "Add your city"}
              <IconArrow />
            </span>
          </button>
        )}

        <Toggle checked={share} onChange={(next) => city && save(city, next)} label="Let friends see my city" />

        <div className="settings-actions">
          <InviteButton handle={profile.handle} />
          <button className="mono-label link" onClick={onLogout}>
            Log out
          </button>
        </div>
      </section>
    </div>
  );
};

const TravelCard = ({ suggestion, onAccept, onDismiss }) => (
  <aside className="travel-card" aria-live="polite">
    <p className="mono-label">You've traveled</p>
    {suggestion.city ? (
      <p className="travel-text">
        Looks like you're in <em>{cityName(suggestion.city.label)}</em>. Update your city?
      </p>
    ) : (
      <p className="travel-text">
        Your clock moved to <em>{suggestion.timezone.split("/").pop().replace(/_/g, " ")}</em> time. Somewhere new?
      </p>
    )}
    <div className="travel-actions">
      <button className="chip chip--ghost" onClick={onDismiss}>
        Not now
      </button>
      <button className="chip" onClick={onAccept}>
        {suggestion.city ? "Update" : "Use my location"}
      </button>
    </div>
  </aside>
);

const InboxScreen = ({
  me,
  messages,
  currentPhase,
  moon,
  moonPhaseLoading,
  onOpen,
  travel,
}) => {
  const incoming = messages.filter((msg) => msg.from !== "You");
  const pending = incoming.filter((msg) => (msg.locked || !msg.receivePhoto) && !msg.archived);
  const sent = messages.filter((msg) => msg.from === "You");
  const greeting = getTimeBasedGreeting(me.timezone);

  return (
    <div className="app-shell app-shell--nav">
      <header className="home-head">
        <h1 className="display display--fit">
          {greeting}
          {me.name ? (
            <>
              , <em>{me.name}</em>
            </>
          ) : null}
        </h1>
      </header>

      {travel && <TravelCard {...travel} />}

      <section className="moon-panel" aria-label="Tonight's moon">
        <ThresholdMoon fraction={moon.fraction} size={232} spinnable />
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
 *  Select Recipient: letters go to friends
 *  --------------------------*/

const SelectRecipientScreen = ({ friends, onSelect, onBack, onFindFriends }) => {
  const [filter, setFilter] = useState("");
  const q = filter.trim().toLowerCase().replace(/^@/, "");
  const shown = friends.filter(
    (f) => !q || f.profile.name.toLowerCase().includes(q) || f.profile.handle.includes(q)
  );

  return (
    <div className="app-shell">
      <TopBar onBack={onBack} step={2} />

      <div className="step-body step-body--top stagger">
        <p className="mono-label">Recipient</p>
        <h1 className="display">Who is this letter for?</h1>

        {friends.length === 0 ? (
          <>
            <p className="empty">Letters go to friends. Add someone first.</p>
            <button className="btn btn--ink btn--block" onClick={onFindFriends}>
              Find friends <IconArrow />
            </button>
          </>
        ) : (
          <>
            {friends.length > 5 && (
              <input
                className="finder-input"
                type="search"
                placeholder="Search friends"
                autoComplete="off"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                aria-label="Search friends"
              />
            )}
            <div className="picker">
              {shown.map((f) => (
                <button key={f.id} className="person person--row person--pick" onClick={() => onSelect(f.profile)}>
                  <span className="person-main">
                    <span className="person-name">{f.profile.name}</span>
                    <span className="mono-label">
                      {f.location
                        ? `${cityName(f.location.city)} · ${formatLocalTime(f.location.timezone)}`
                        : `@${f.profile.handle}`}
                    </span>
                  </span>
                  <IconArrow />
                </button>
              ))}
            </div>
            <p className="field-hint">They'll open it only after capturing their own moon.</p>
          </>
        )}
      </div>
    </div>
  );
};

/** ---------------------------
 *  Compose Letter
 *  --------------------------*/

const ComposeLetterScreen = ({
  recipient,
  message,
  onChange,
  onSend,
  onSealed,
  onBack,
  currentPhase,
}) => {
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
            readOnly={sending}
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
        <ThresholdMoon fraction={moon.fraction} size={150} />
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
 *  (seen state lives on the letter, so it's once across devices)
 *  --------------------------*/

const HOLD_TO_PAUSE_MS = 220;

const cityOf = (location) => (location ? location.split(",")[0] : "");

const REGION_ABBREVIATIONS = {
  // United States
  Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA", Colorado: "CO",
  Connecticut: "CT", Delaware: "DE", "District of Columbia": "DC", Florida: "FL", Georgia: "GA",
  Hawaii: "HI", Idaho: "ID", Illinois: "IL", Indiana: "IN", Iowa: "IA", Kansas: "KS", Kentucky: "KY",
  Louisiana: "LA", Maine: "ME", Maryland: "MD", Massachusetts: "MA", Michigan: "MI", Minnesota: "MN",
  Mississippi: "MS", Missouri: "MO", Montana: "MT", Nebraska: "NE", Nevada: "NV", "New Hampshire": "NH",
  "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY", "North Carolina": "NC", "North Dakota": "ND",
  Ohio: "OH", Oklahoma: "OK", Oregon: "OR", Pennsylvania: "PA", "Rhode Island": "RI",
  "South Carolina": "SC", "South Dakota": "SD", Tennessee: "TN", Texas: "TX", Utah: "UT", Vermont: "VT",
  Virginia: "VA", Washington: "WA", "West Virginia": "WV", Wisconsin: "WI", Wyoming: "WY",
  // Canada
  Alberta: "AB", "British Columbia": "BC", Manitoba: "MB", "New Brunswick": "NB",
  "Newfoundland and Labrador": "NL", "Nova Scotia": "NS", Ontario: "ON", "Prince Edward Island": "PE",
  Quebec: "QC", Saskatchewan: "SK",
  // Australia
  "New South Wales": "NSW", Victoria: "VIC", Queensland: "QLD", "Western Australia": "WA",
  "South Australia": "SA", Tasmania: "TAS", "Australian Capital Territory": "ACT", "Northern Territory": "NT",
};

const COUNTRY_SHORT = { "United States": "USA", "United Kingdom": "UK", "United Arab Emirates": "UAE" };

// "City, Region, Country" → parts (city labels come from the geocoder in that shape)
function parsePlace(label) {
  const parts = (label || "").split(",").map((p) => p.trim()).filter(Boolean);
  return {
    city: parts[0] || "",
    region: parts.length >= 3 ? parts[1] : null,
    country: parts.length >= 2 ? parts[parts.length - 1] : null,
  };
}

// Same country: just the cities. Abroad: city, short region code if there is one, and country.
function formatRoute(fromLabel, toLabel) {
  if (!fromLabel || !toLabel) return cityOf(fromLabel || toLabel) || "Location unavailable";
  const a = parsePlace(fromLabel);
  const b = parsePlace(toLabel);
  if (a.country && a.country === b.country) return `${a.city} ↔ ${b.city}`;
  const abroad = (p) =>
    [p.city, REGION_ABBREVIATIONS[p.region], COUNTRY_SHORT[p.country] || p.country].filter(Boolean).join(", ");
  return `${abroad(a)} ↔ ${abroad(b)}`;
}

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

          const locationLine = formatRoute(sendLocation, receiveLocation);

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

function cityLabel(item) {
  const region = item.admin1 && item.admin1 !== item.name ? `, ${item.admin1}` : "";
  return `${item.name}${region}${item.country ? `, ${item.country}` : ""}`;
}

async function searchCities(query, { signal, countryCode } = {}) {
  const country = countryCode ? `&countryCode=${countryCode}` : "";
  const response = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=30&language=en&format=json${country}`,
    { signal }
  );
  const data = await response.json();
  const seen = new Set();
  const cities = [];
  for (const item of (data?.results || []).filter(isCityResult)) {
    const label = cityLabel(item);
    if (seen.has(label)) continue;
    seen.add(label);
    cities.push({ label, timezone: item.timezone, lat: item.latitude, lon: item.longitude });
  }
  return cities;
}

// Finds the city the device is in. Only the city's centre is kept, never the raw position.
async function detectCurrentCity() {
  if (!navigator.geolocation) throw new Error("Location isn't available on this device.");
  const position = await new Promise((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(resolve, reject, { maximumAge: 10 * 60 * 1000, timeout: 15000 })
  ).catch((e) => {
    throw new Error(e?.code === 1 ? "Location permission was declined." : "Couldn't find your location.");
  });
  const { latitude, longitude } = position.coords;
  const place = await fetch(
    `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=en`
  ).then((r) => r.json());
  const name = place.city || place.locality;
  if (name) {
    const [match] = await searchCities(name, { countryCode: place.countryCode });
    if (match) return match;
  }
  return {
    label: [name, place.countryName].filter(Boolean).join(", ") || "Your location",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    lat: Math.round(latitude * 10) / 10,
    lon: Math.round(longitude * 10) / 10,
  };
}

async function hasLocationPermission() {
  try {
    const status = await navigator.permissions?.query({ name: "geolocation" });
    return status?.state === "granted";
  } catch {
    return false;
  }
}

// Debounced city search for a text field; skips searching once `selected` matches the text
function useCitySearch(query, selected) {
  const [suggestions, setSuggestions] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const q = query.trim();
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      if (q.length < 2 || q === selected) {
        setSuggestions([]);
        return;
      }
      setLoading(true);
      try {
        const cities = await searchCities(q, { signal: controller.signal });
        setSuggestions(cities.slice(0, 6));
      } catch (e) {
        if (e.name !== "AbortError") setSuggestions([]);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 300);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query, selected]);

  return { suggestions, loading };
}

/** ---------------------------
 *  Main App
 *  --------------------------*/

const MAIN_ROUTES = ["inbox", "friends", "gallery", "profile"];
const TRAVEL_MIN_MILES = 50;
const TRAVEL_DISMISSED_KEY = "mooncode_travel_dismissed";

const MoonCodeApp = () => {
  // undefined while Supabase restores the saved session, null when signed out
  const [session, setSession] = useState(undefined);
  const [recovering, setRecovering] = useState(false);
  // profile + city for the signed-in user, tagged with whose they are
  const [account, setAccount] = useState(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [friendData, setFriendData] = useState({ uid: null, rows: [] });
  const [invite, setInvite] = useState(() => takeInviteFromUrl());

  const [route, setRoute] = useState(() => {
    try {
      const stored = sessionStorage.getItem("mooncode_route");
      if (MAIN_ROUTES.includes(stored)) return stored;
    } catch {
      // storage unavailable
    }
    return "inbox";
  });

  const [messages, setMessages] = useState([]);
  const [activeMessage, setActiveMessage] = useState(null);

  const [sendPhoto, setSendPhoto] = useState(null);
  const [recipient, setRecipient] = useState(null);
  // where the sealed envelope sat on the letter screen, so the next screen can pick it up from there
  const [sealedFrom, setSealedFrom] = useState(null);
  // sent letters opened since the sender last looked — shown once as stories after login
  const [openedStories, setOpenedStories] = useState(null);
  const [messageText, setMessageText] = useState("");
  const [travel, setTravel] = useState(null);

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

  // Session: restore on load, follow sign-in / sign-out / password-reset links
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      setSession(next ?? null);
      if (event === "PASSWORD_RECOVERY") setRecovering(true);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const uid = session?.user?.id ?? null;

  const loadAccount = async (userId) => {
    try {
      const [profile, location] = await Promise.all([fetchProfile(userId), fetchLocation(userId)]);
      setAccount({ uid: userId, profile, location });
    } catch (e) {
      console.error("loadAccount", e);
      setAccount({ uid: userId, profile: null, location: null, error: describeError(e) });
    }
  };

  useEffect(() => {
    if (uid) loadAccount(uid);
  }, [uid]);

  const accountReady = !!uid && account?.uid === uid;
  const profile = accountReady ? account.profile : null;
  const myLocation = accountReady ? account.location : null;
  const myId = profile?.id ?? null;

  const me = useMemo(
    () =>
      profile
        ? {
            id: profile.id,
            handle: profile.handle,
            name: profile.display_name,
            timezone: myLocation?.timezone,
            city: myLocation?.city || "",
            coords: myLocation ? { lat: myLocation.lat, lon: myLocation.lon } : null,
          }
        : null,
    [profile, myLocation]
  );

  const friendships = friendData.uid === myId ? friendData.rows : [];
  const friends = friendships.filter((f) => f.status === "accepted");
  const incomingRequests = friendships.filter((f) => f.status === "pending" && f.incoming).length;

  const refreshFriends = async () => {
    if (!myId) return;
    try {
      setFriendData({ uid: myId, rows: await fetchFriendships(myId) });
    } catch (e) {
      console.error("fetchFriendships", e);
    }
  };
  const refreshFriendsRef = useRef(refreshFriends);
  useEffect(() => {
    refreshFriendsRef.current = refreshFriends;
  });

  // Friends: load, and refresh live when someone asks, accepts or unfriends
  useEffect(() => {
    if (!myId) return;
    refreshFriendsRef.current();
    const refresh = () => refreshFriendsRef.current();
    const channel = supabase
      .channel(`friendships-${myId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "friendships", filter: `requester_id=eq.${myId}` }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "friendships", filter: `addressee_id=eq.${myId}` }, refresh)
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [myId]);

  // Invite link: once signed up, send the inviter a friend request
  useEffect(() => {
    if (!myId || !invite) return;
    let alive = true;
    (async () => {
      try {
        const inviter = await fetchProfileByHandle(invite);
        if (inviter && inviter.id !== myId) await sendFriendRequest(myId, inviter.id);
        clearInvite();
        if (alive) {
          setInvite(null);
          refreshFriendsRef.current();
        }
      } catch (e) {
        console.error("invite", e);
      }
    })();
    return () => {
      alive = false;
    };
  }, [myId, invite]);

  // Letters: load + realtime subscribe
  useEffect(() => {
    if (!myId) return;
    let isMounted = true;

    fetchMessagesForUser(myId)
      .then((rows) => {
        if (!isMounted) return;
        const mapped = rows.map((r) => mapRowToMessage(r, myId));
        setMessages(mapped);
        const opened = mapped
          .filter((m) => m.from === "You" && m.receivePhoto && !m.senderSeenOpenedAt)
          .sort((a, b) => new Date(a.receiveAt) - new Date(b.receiveAt));
        setOpenedStories(opened.length ? { uid: myId, items: opened } : null);
      })
      .catch((err) => console.error("fetchMessagesForUser", err));

    const upsert = (payload) => {
      const row = payload.new;
      if (!row) return;
      const mapped = mapRowToMessage(row, myId);
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === mapped.id);
        if (idx === -1) return [mapped, ...prev];
        const next = [...prev];
        next[idx] = mapped;
        return next;
      });
    };

    const channel = supabase
      .channel(`messages-${myId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "messages", filter: `sender_id=eq.${myId}` }, upsert)
      .on("postgres_changes", { event: "*", schema: "public", table: "messages", filter: `recipient_id=eq.${myId}` }, upsert)
      .subscribe();

    return () => {
      isMounted = false;
      supabase.removeChannel(channel);
    };
  }, [myId]);

  // Travel: once per visit, see whether the phone is somewhere other than the saved city
  const savedCity = myLocation?.city;
  const savedTimezone = myLocation?.timezone;
  const savedLat = myLocation?.lat;
  const savedLon = myLocation?.lon;
  useEffect(() => {
    if (!myId || !savedCity) return;
    let alive = true;
    (async () => {
      let dismissed = null;
      try {
        dismissed = sessionStorage.getItem(TRAVEL_DISMISSED_KEY);
      } catch {
        // storage unavailable
      }
      const deviceTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

      if (await hasLocationPermission()) {
        try {
          const here = await detectCurrentCity();
          const miles = getDistanceMiles(null, null, { lat: savedLat, lon: savedLon }, here);
          if (alive && miles !== null && miles > TRAVEL_MIN_MILES && dismissed !== here.label) {
            setTravel({ city: here });
          }
          return;
        } catch (e) {
          console.warn("travel check", e);
        }
      }
      // no location permission: a changed time zone is still a good hint
      if (alive && savedTimezone && deviceTimezone !== savedTimezone && dismissed !== deviceTimezone) {
        setTravel({ city: null, timezone: deviceTimezone });
      }
    })();
    return () => {
      alive = false;
    };
  }, [myId, savedCity, savedTimezone, savedLat, savedLon]);

  useEffect(() => {
    if (MAIN_ROUTES.includes(route)) {
      try {
        sessionStorage.setItem("mooncode_route", route);
      } catch {
        // storage unavailable
      }
    }
    // each screen starts at the top so the nav and browser chrome don't jump between tabs
    window.scrollTo(0, 0);
  }, [route]);

  const sortedMessages = useMemo(
    () => [...messages].sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt)),
    [messages]
  );

  const updateLocation = (location) => setAccount((prev) => ({ ...prev, location }));

  const acceptTravel = async () => {
    try {
      const city = travel.city ?? (await detectCurrentCity());
      updateLocation(await saveLocation(myId, city, myLocation?.share_with_friends ?? true));
      setTravel(null);
    } catch (e) {
      showSupabaseError(e, "Couldn't update your city.");
    }
  };

  const dismissTravel = () => {
    try {
      sessionStorage.setItem(TRAVEL_DISMISSED_KEY, travel.city?.label ?? travel.timezone);
    } catch {
      // storage unavailable
    }
    setTravel(null);
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setMessages([]);
    setOpenedStories(null);
    setTravel(null);
    setRecipient(null);
    setRoute("inbox");
  };

  const handleStartSend = (to = null) => {
    setRecipient(to);
    setMessageText("");
    setRoute("sendCapture");
  };

  const handleSelectRecipient = (friend) => {
    setRecipient(friend);
    setRoute("compose");
  };

  const handleSendMessage = async () => {
    if (!me || !recipient) return false;
    try {
      const row = await insertMessage({
        sender: { id: me.id, name: me.name },
        recipient: { id: recipient.id, name: recipient.name },
        body: messageText.trim() || "A message carried by moonlight.",
        sendPhoto,
      });

      const mapped = mapRowToMessage(row, me.id);
      setMessages((prev) => [mapped, ...prev.filter((m) => m.id !== mapped.id)]);
      setActiveMessage(mapped);
      return true;
    } catch (e) {
      showSupabaseError(e, "Failed to send the letter.");
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

  const handleStorySeen = (id) => {
    markOpenedLetterSeen(id);
    const seenAt = new Date().toISOString();
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, senderSeenOpenedAt: seenAt } : m)));
  };

  // ---- which stage of the app to show ----

  if (recovering) {
    return (
      <div className="mooncode-app">
        <SetPasswordScreen onDone={() => setRecovering(false)} />
      </div>
    );
  }

  if (session === undefined || (session && !accountReady)) {
    return (
      <div className="mooncode-app">
        <div className="app-shell app-loading" aria-label="Loading">
          <ThresholdMoon fraction={moon.fraction} size={120} />
        </div>
      </div>
    );
  }

  if (account?.error && accountReady) {
    return (
      <div className="mooncode-app">
        <div className="app-shell app-loading">
          <p className="mono-label">Couldn't load your account</p>
          <p className="field-hint">{account.error}</p>
          <button className="btn btn--ink" onClick={() => loadAccount(uid)}>
            Try again
          </button>
          <button className="mono-label link" onClick={handleLogout}>
            Log out
          </button>
        </div>
      </div>
    );
  }

  if (!session || !profile || !myLocation || setupOpen) {
    return (
      <div className="mooncode-app">
        <OnboardingFlow
          session={session}
          profile={profile}
          location={myLocation}
          friendships={friendships}
          invite={invite}
          onProfileCreated={(p) => {
            setSetupOpen(true);
            setAccount((prev) => ({ ...prev, profile: p }));
          }}
          onLocationSaved={(loc) => {
            setSetupOpen(true);
            updateLocation(loc);
          }}
          onFriendsChanged={refreshFriends}
          onFinished={() => {
            setSetupOpen(false);
            setRoute("inbox");
          }}
          currentPhase={currentPhase}
          moon={moon}
        />
      </div>
    );
  }

  const showNav = MAIN_ROUTES.includes(route);
  const isNight = route === "sendCapture" || route === "unlockCapture";

  return (
    <div className={`mooncode-app ${isNight ? "is-night" : ""}`}>
      {route === "inbox" && (
        <InboxScreen
          me={me}
          messages={sortedMessages}
          currentPhase={currentPhase}
          moon={moon}
          moonPhaseLoading={moonPhaseLoading}
          onOpen={handleOpenMessage}
          travel={travel ? { suggestion: travel, onAccept: acceptTravel, onDismiss: dismissTravel } : null}
        />
      )}

      {route === "friends" && (
        <FriendsScreen me={me} friendships={friendships} onChanged={refreshFriends} onWrite={handleStartSend} />
      )}

      {route === "profile" && (
        <ProfileScreen
          profile={profile}
          location={myLocation}
          stats={{
            sent: messages.filter((m) => m.from === "You").length,
            received: messages.filter((m) => m.from !== "You").length,
            friends: friends.length,
          }}
          onLocationSaved={updateLocation}
          onLogout={handleLogout}
        />
      )}

      {route === "sendCapture" && (
        <MoonCameraCapture
          title="Capture your moon"
          subtitle="Seal your letter with tonight's light"
          step={1}
          locationLabel={me.city}
          locationCoords={me.coords}
          onBack={() => setRoute("inbox")}
          onVerifiedMoon={(capture) => {
            setSendPhoto(capture);
            setRoute(recipient ? "compose" : "selectRecipient");
          }}
        />
      )}

      {route === "selectRecipient" && (
        <SelectRecipientScreen
          friends={friends}
          onSelect={handleSelectRecipient}
          onBack={() => setRoute("sendCapture")}
          onFindFriends={() => setRoute("friends")}
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
          locationLabel={me.city}
          locationCoords={me.coords}
          onBack={() => setRoute("inbox")}
          onVerifiedMoon={(capture) => {
            (async () => {
              try {
                const row = await unlockMessage({
                  id: activeMessage.id,
                  receivePhoto: capture,
                });

                const mapped = mapRowToMessage(row, me.id);
                setActiveMessage(mapped);
                setMessages((prev) => prev.map((m) => (m.id === mapped.id ? mapped : m)));
                setRoute("printing");
              } catch (e) {
                showSupabaseError(e, "Failed to unlock the letter.");
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
          onSend={() => handleStartSend()}
          badges={{ friends: incomingRequests > 0 }}
        />
      )}

      {route === "inbox" && openedStories?.uid === me.id && (
        <OpenedStories
          items={openedStories.items}
          onSeen={handleStorySeen}
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
