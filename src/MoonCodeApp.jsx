import React, { useEffect, useMemo, useState, useRef } from "react";
import "./index.css";
import { supabase } from "./supabaseClient";

/** ---------------------------
 *  Helpers: Supabase I/O
 *  --------------------------*/

// PostgREST filter strings need quoting if names contain spaces, commas, etc.
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

// Map DB row -> UI message (make "You" consistent)
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
    archived: !!row.receive_photo, // once unlocked it goes to archive
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
 *  Moon Model Configuration
 *  --------------------------*/

const TM_MODEL_URL = import.meta.env.BASE_URL + "moon-model/model.json";
const TM_METADATA_URL = import.meta.env.BASE_URL + "moon-model/metadata.json";

// Must match EXACTLY what's in your metadata.json labels array
const MOON_CLASS_NAME = "Moon";

// Confidence threshold: lower = more permissive, higher = stricter
const MOON_THRESHOLD = 0.75;

/** ---------------------------
 *  MoonCameraCapture Component (Improved)
 *  --------------------------*/

function MoonCameraCapture({ title, subtitle, onVerifiedMoon, onBack }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  const [model, setModel] = useState(null);
  const [labels, setLabels] = useState([]);
  const [modelLoading, setModelLoading] = useState(true);
  const [modelError, setModelError] = useState("");

  const [stream, setStream] = useState(null);
  const [cameraError, setCameraError] = useState("");

  const [capturedDataUrl, setCapturedDataUrl] = useState(null);
  const [verifying, setVerifying] = useState(false);
  const [resultText, setResultText] = useState("");

  // 1. Load Teachable Machine model
  useEffect(() => {
    let alive = true;

    async function loadModel() {
      setModelLoading(true);
      setModelError("");

      try {
        // First, verify the files are accessible
        console.log("🔍 Checking model files...");

        const modelCheck = await fetch(TM_MODEL_URL);
        if (!modelCheck.ok) {
          throw new Error(
            `model.json not found (${modelCheck.status}). Make sure it's in public/moon-model/`
          );
        }
        console.log("✅ model.json accessible");

        const metaCheck = await fetch(TM_METADATA_URL);
        if (!metaCheck.ok) {
          throw new Error(
            `metadata.json not found (${metaCheck.status}). Make sure it's in public/moon-model/`
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
          console.warn("⚠️ tmImage failed, trying TensorFlow.js directly:", tmError);

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

    async function startCamera() {
      try {
        setCameraError("");
        const mediaStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment", width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false,
        });

        if (!alive) {
          mediaStream.getTracks().forEach((t) => t.stop());
          return;
        }

        setStream(mediaStream);
        if (videoRef.current) {
          videoRef.current.srcObject = mediaStream;
          await videoRef.current.play();
        }
        console.log("✅ Camera started");
      } catch (e) {
        console.error("❌ Camera error:", e);
        if (alive) {
          setCameraError(
            e.name === "NotAllowedError"
              ? "Camera permission denied. Please allow camera access."
              : e.name === "NotFoundError"
              ? "No camera found on this device."
              : `Camera error: ${e.message}`
          );
        }
      }
    }

    startCamera();

    return () => {
      alive = false;
    };
  }, []);

  // Stop stream on unmount or stream change
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
    if (!video || !canvas) return;

    const w = video.videoWidth || 640;
    const h = video.videoHeight || 480;

    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, w, h);

    const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
    setCapturedDataUrl(dataUrl);
    console.log("📷 Photo captured");
  };

  const retake = () => {
    setCapturedDataUrl(null);
    setResultText("");
  };

  // 4. Verify moon with model
  const verifyMoon = async () => {
    if (!model) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    setVerifying(true);
    setResultText("");

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
        setResultText(`✦ Moon verified (${Math.round(moonProb * 100)}%)`);
        onVerifiedMoon({
          dataUrl: capturedDataUrl,
          confidence: moonProb,
          verifiedAt: new Date().toISOString(),
        });
      } else {
        setResultText(
          `Not enough moon (${Math.round(moonProb * 100)}%). Point at the moon and try again.`
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
            <div className="capture-inner" style={{ padding: 0 }}>
              {!capturedDataUrl ? (
                <video
                  ref={videoRef}
                  playsInline
                  muted
                  style={{
                    width: "100%",
                    borderRadius: 16,
                    background: "#0a0a0f",
                  }}
                />
              ) : (
                <img
                  src={capturedDataUrl}
                  alt="Captured"
                  style={{ width: "100%", borderRadius: 16 }}
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
                disabled={modelLoading}
                title="Take photo"
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
              <p
                className="capture-instruction"
                style={{
                  marginTop: 12,
                  color: resultText.includes("verified") ? "#90EE90" : "#ffcc00",
                }}
              >
                {resultText}
              </p>
            )}
          </>
        )}

        {/* Debug info (remove in production) */}
        {!modelLoading && model && (
          <p style={{ fontSize: 10, opacity: 0.5, marginTop: 20 }}>
            Model: {model.type} | Labels: {labels.join(", ")} | Threshold: {MOON_THRESHOLD * 100}%
          </p>
        )}
      </div>
    </div>
  );
}

/** ---------------------------
 *  Moon phase utilities
 *  --------------------------*/

const INITIAL_CONTACTS = [
  { id: 1, name: "Luna Chen", initials: "LC", location: "Queens, NY" },
  { id: 2, name: "Orion Blake", initials: "OB", location: "Portland, OR" },
  { id: 3, name: "Stella Ray", initials: "SR", location: "Santa Fe, NM" },
];

const MOON_PHASES = [
  {
    name: "New Moon",
    meaning: "beginnings",
    personalMessage:
      "Tonight the sky holds its breath. This is your moment to plant seeds in the dark—wishes, intentions, quiet promises to yourself. What you begin now grows in secret.",
  },
  {
    name: "Waxing Crescent",
    meaning: "intentions",
    personalMessage:
      "A sliver of light emerges. Your intentions are taking their first breath. Stay gentle with your hopes—they are young and tender, like new leaves reaching toward warmth.",
  },
  {
    name: "First Quarter",
    meaning: "decisions",
    personalMessage:
      "Half-lit, half-shadowed. You stand at a crossroads tonight. The universe asks you to choose, to commit. Trust the direction your heart leans.",
  },
  {
    name: "Waxing Gibbous",
    meaning: "refinement",
    personalMessage:
      "Almost full, almost there. This is the time to adjust, to polish, to tend carefully to what you've been building. Patience—the bloom is near.",
  },
  {
    name: "Full Moon",
    meaning: "culmination",
    personalMessage:
      "The moon shows her whole face tonight. Everything is illuminated—your work, your heart, your truth. Let yourself be seen. Celebrate how far you've traveled.",
  },
  {
    name: "Waning Gibbous",
    meaning: "gratitude",
    personalMessage:
      "The light begins its retreat. Take this moment to give thanks—for lessons learned, for love received, for the fullness that was. Gratitude softens the release.",
  },
  {
    name: "Last Quarter",
    meaning: "release",
    personalMessage:
      "Half the light has faded. What no longer serves you? This is your permission to let go—of old stories, of heavy things, of what has run its course.",
  },
  {
    name: "Waning Crescent",
    meaning: "rest",
    personalMessage:
      "The thinnest crescent whispers: rest now. Retreat inward. Dream deeply. The darkness before renewal is not emptiness—it is preparation.",
  },
];

const MS_PER_HOUR = 1000 * 60 * 60;
const MS_PER_DAY = 1000 * 60 * 60 * 24;
const SYNODIC_MONTH = 29.53058867;
const KNOWN_NEW_MOON = new Date(Date.UTC(2000, 0, 6, 18, 14, 0));

const getMoonPhase = (date) => {
  const daysSince = (date - KNOWN_NEW_MOON) / MS_PER_DAY;
  const ageDays = ((daysSince % SYNODIC_MONTH) + SYNODIC_MONTH) % SYNODIC_MONTH;
  const phaseIndex = Math.floor((ageDays / SYNODIC_MONTH) * 8 + 0.5) % 8;
  return MOON_PHASES[phaseIndex];
};

const getLocationOffsetHours = (location = "") => {
  const match = location.match(/(?:UTC|GMT)\s*([+-]\d{1,2})/i);
  if (!match) return 0;
  const offset = Number(match[1]);
  if (Number.isNaN(offset)) return 0;
  return Math.max(-12, Math.min(14, offset));
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

const BottomNav = ({ current, onSelect, onSend }) => (
  <div className="bottom-nav">
    <div className="nav-line" />
    <div className="nav-content">
      <button
        className={`nav-item ${current === "inbox" ? "is-active" : ""}`}
        onClick={() => onSelect("inbox")}
      >
        <span className="nav-label">Home</span>
      </button>
      <button
        className={`nav-item nav-item--primary ${current === "send" ? "is-active" : ""}`}
        onClick={onSend}
      >
        <span className="nav-icon-send">✦</span>
        <span className="nav-label">Compose</span>
      </button>
      <button
        className={`nav-item ${current === "gallery" ? "is-active" : ""}`}
        onClick={() => onSelect("gallery")}
      >
        <span className="nav-label">Archive</span>
      </button>
    </div>
  </div>
);

const OnboardingScreen = ({ userData, onUpdate, onBegin }) => (
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
            value={userData.location}
            onChange={(e) => onUpdate("location", e.target.value)}
          />
        </div>
      </div>

      <button onClick={onBegin} className="btn-primary" disabled={!userData.name.trim()}>
        Enter
      </button>
    </div>
  </div>
);

const InboxScreen = ({ userData, messages, currentPhase, onOpen }) => {
  const incoming = messages.filter((msg) => msg.from !== "You");
  const pending = incoming.filter((msg) => (msg.locked || !msg.receivePhoto) && !msg.archived);
  const sent = messages.filter((msg) => msg.from === "You");

  return (
    <div className="app-shell">
      <div className="inbox-content">
        <header className="inbox-header">
          <p className="date-display">{formatFullDate(new Date())}</p>
          <h1 className="greeting">Good evening{userData.name ? `, ${userData.name}` : ""}</h1>
        </header>

        <div className="phase-card">
          <div className="phase-visual">
            <MoonIcon phase={currentPhase} size={64} />
          </div>
          <div className="phase-info">
            <p className="phase-name">{currentPhase.name}</p>
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

// ✅ Type ANY recipient name; still shows the 3 as suggestions
const SelectRecipientScreen = ({ suggestions, onSelect, onBack, defaultValue = "" }) => {
  const [name, setName] = useState(defaultValue);

  return (
    <div className="app-shell">
      <div className="recipient-content">
        <button onClick={onBack} className="back-btn">
          ← Back
        </button>

        <div className="recipient-header">
          <p className="step-indicator">Step 1 of 2</p>
          <h1>Who will receive this letter?</h1>
        </div>

        <div className="form-field" style={{ width: "100%", marginTop: 12 }}>
          <label>Recipient name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <button
          className="btn-send"
          disabled={!name.trim()}
          onClick={() => onSelect({ name: name.trim() })}
          style={{ marginTop: 12 }}
        >
          Continue →
        </button>

        <div className="recipient-list">
          {suggestions.map((contact) => (
            <button
              key={contact.id}
              onClick={() => {
                setName(contact.name);
                onSelect({ name: contact.name });
              }}
              className="recipient-card"
            >
              <div className="recipient-initials">{contact.initials}</div>
              <div className="recipient-info">
                <span className="recipient-name">{contact.name}</span>
                <span className="recipient-location">{contact.location}</span>
              </div>
              <span className="recipient-arrow">→</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

const ComposeLetterScreen = ({ recipient, message, onChange, onSend, onBack }) => (
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
          <h2>Revealing your letter</h2>
          <p>The moonlight develops the message...</p>
          <p style={{ marginTop: 12, opacity: 0.7, fontSize: 12 }}>
            From {message?.from}
          </p>
        </div>
      </div>
    </div>
  );
};

const GalleryScreen = ({ messages, userName }) => {
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
            {galleryItems.map((msg) => (
              <div key={msg.id} className="gallery-card">
                <div className="gallery-from">
                  {msg.location || "Unknown location"}
                </div>

                <div className="gallery-moons">
                  <div className="gallery-moon">
                    <div
                      className="moon-photo"
                      style={{
                        "--photo-hue": msg.sendPhoto?.hue ?? 210,
                        "--photo-offset": msg.sendPhoto?.offset ?? 18,
                      }}
                    />
                    <div className="moon-meta">
                      <span className="moon-location">Send moon</span>
                      <span className="moon-date">
                        {formatShortDateTime(new Date(msg.sentAt))}
                      </span>
                    </div>
                  </div>

                  <div className="gallery-connector">↔</div>

                  <div className="gallery-moon">
                    <div
                      className="moon-photo"
                      style={{
                        "--photo-hue": msg.receivePhoto?.hue ?? 240,
                        "--photo-offset": msg.receivePhoto?.offset ?? 8,
                      }}
                    />
                    <div className="moon-meta">
                      <span className="moon-location">Receive moon</span>
                      <span className="moon-date">
                        {msg.receiveAt ? formatShortDateTime(new Date(msg.receiveAt)) : "—"}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="gallery-dates">
                  <span>{formatShortDateTime(new Date(msg.sentAt))}</span>
                  <span>
                    {msg.receiveAt ? formatShortDateTime(new Date(msg.receiveAt)) : "—"}
                  </span>
                </div>
              </div>
            ))}
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
  const [route, setRoute] = useState("onboarding");
  const [userData, setUserData] = useState({ name: "", location: "" });

  const [messages, setMessages] = useState([]);
  const [activeMessage, setActiveMessage] = useState(null);

  const [sendPhoto, setSendPhoto] = useState(null);
  const [recipient, setRecipient] = useState(null);
  const [recipientDraft, setRecipientDraft] = useState("");
  const [messageText, setMessageText] = useState("");

  const currentPhase = useMemo(() => {
    const now = new Date();
    const offsetHours = getLocationOffsetHours(userData.location);
    const adjusted = new Date(now.getTime() + offsetHours * MS_PER_HOUR);
    return getMoonPhase(adjusted);
  }, [userData.location]);

  const sortedMessages = useMemo(
    () => [...messages].sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt)),
    [messages]
  );

  const updateUserData = (field, value) => setUserData((p) => ({ ...p, [field]: value }));

  // Load + realtime subscribe
  useEffect(() => {
    const viewerName = userData.name?.trim();
    if (!viewerName) return;

    let isMounted = true;

    fetchMessagesForUser(viewerName)
      .then((rows) => {
        if (!isMounted) return;
        setMessages(rows.map((r) => mapRowToMessage(r, viewerName)));
      })
      .catch((err) => console.error("fetchMessagesForUser", err));

    const channel = supabase
      .channel(`messages-${viewerName}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "messages" },
        (payload) => {
          const row = payload.new;
          if (!row) return;

          if (row.sender !== viewerName && row.recipient !== viewerName) return;

          const mapped = mapRowToMessage(row, viewerName);

          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === mapped.id);
            if (idx === -1) return [mapped, ...prev];
            const next = [...prev];
            next[idx] = mapped;
            return next;
          });
        }
      )
      .subscribe();

    return () => {
      isMounted = false;
      supabase.removeChannel(channel);
    };
  }, [userData.name]);

  const handleStartSend = () => setRoute("sendCapture");

  const handleSelectRecipient = (contact) => {
    setRecipient(contact);
    setRecipientDraft(contact?.name || "");
    setRoute("compose");
  };

  const handleSendMessage = async () => {
    const sender = userData.name.trim();
    if (!sender) {
      alert("Enter your name first.");
      setRoute("onboarding");
      return;
    }
    if (!recipient?.name?.trim()) return;

    try {
      const row = await insertMessage({
        sender,
        recipient: recipient.name.trim(),
        body: messageText.trim() || "A message carried by moonlight.",
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
    if (msg.locked || !msg.receivePhoto) setRoute("unlockCapture");
  };

  const handlePrintingComplete = () => setRoute("inbox");

  const showNav = ["inbox", "compose", "gallery", "selectRecipient"].includes(route);

  return (
    <div className="mooncode-app">
      {route === "onboarding" && (
        <OnboardingScreen
          userData={userData}
          onUpdate={updateUserData}
          onBegin={() => setRoute("inbox")}
        />
      )}

      {route === "inbox" && (
        <InboxScreen
          userData={userData}
          messages={sortedMessages}
          currentPhase={currentPhase}
          onOpen={handleOpenMessage}
        />
      )}

      {route === "sendCapture" && (
        <MoonCameraCapture
          title="Capture your moon"
          subtitle="Seal your letter with tonight's light"
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
        />
      )}

      {route === "messageSent" && (
        <MessageSentScreen recipient={recipient} onDone={handleMessageSentComplete} />
      )}

      {route === "unlockCapture" && (
        <MoonCameraCapture
          title="Capture to unlock"
          subtitle="Your moon will reveal this letter"
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

      {route === "gallery" && (
        <GalleryScreen messages={messages} userName={userData.name.trim() || "You"} />
      )}

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