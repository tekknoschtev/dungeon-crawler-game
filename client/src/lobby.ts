import Phaser from "phaser";
import { Client, Room } from "@colyseus/sdk";
import { GameScene } from "./scenes/GameScene";
import { UIScene } from "./scenes/UIScene";
import { SERVER_URL, ROOM_NAME, VIEW_W, VIEW_H } from "./config";

// Friendly join code shape — must match the server (DungeonRoom CODE_ALPHABET).
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;

const client = new Client(SERVER_URL);
// Dev-only console handle for debugging matchmaking (stripped from prod builds).
if (import.meta.env.DEV) (window as unknown as { colyseus: Client }).colyseus = client;

// Phaser config — moved here from main.ts so the game only boots after we have a
// connected room. The scenes read that room from the registry (see GameScene).
const gameConfig: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: "game",
  width: VIEW_W,
  height: VIEW_H,
  backgroundColor: "#0b0c10",
  pixelArt: true,
  scale: { mode: Phaser.Scale.RESIZE },
  scene: [GameScene, UIScene],
};

let busy = false; // guards against double create/join while a request is in flight

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

/** Entry point: wire the menu, then auto-join if the URL carries a room code. */
export function startLobby() {
  const nameInput = $<HTMLInputElement>("name");
  const codeInput = $<HTMLInputElement>("code");
  const createBtn = $<HTMLButtonElement>("create");
  const joinBtn = $<HTMLButtonElement>("join");

  nameInput.value = `Hero-${Math.floor(Math.random() * 1000)}`;

  // Force the code field to the canonical uppercase alphabet as the user types.
  codeInput.addEventListener("input", () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  });

  createBtn.addEventListener("click", () => createRoom(nameInput.value));
  joinBtn.addEventListener("click", () => joinRoom(nameInput.value, codeInput.value));
  codeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") joinRoom(nameInput.value, codeInput.value);
  });
  // Enter in the name field does the obvious thing: join if a code is present,
  // otherwise create a new room.
  nameInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (CODE_RE.test(codeInput.value.trim().toUpperCase())) {
      joinRoom(nameInput.value, codeInput.value);
    } else {
      createRoom(nameInput.value);
    }
  });

  // A shared link (?room=CODE) pre-fills the code and shows a focused "join this
  // room" menu — so the joiner can still pick a name before entering, instead of
  // being dropped straight in with the random default.
  const fromUrl = new URLSearchParams(location.search).get("room");
  if (fromUrl && CODE_RE.test(fromUrl.toUpperCase())) {
    const code = fromUrl.toUpperCase();
    codeInput.value = code;
    $<HTMLParagraphElement>("hint").innerHTML = `Joining room <b>${code}</b>`;
    $<HTMLParagraphElement>("hint").hidden = false;
    // Joining a specific room — hide the create path to avoid an accidental
    // "Create Room" tap that would spin up a different session.
    createBtn.hidden = true;
    $<HTMLDivElement>("ordivider").hidden = true;
    nameInput.focus();
    nameInput.select();
  }
}

function playerName(raw: string): string {
  return raw.trim().slice(0, 16) || `Hero-${Math.floor(Math.random() * 1000)}`;
}

async function createRoom(name: string) {
  if (busy) return;
  setBusy(true);
  try {
    const room = await client.create(ROOM_NAME, { name: playerName(name) });
    enterGame(room);
  } catch (err) {
    console.error("Create failed:", err);
    showError("Couldn't create a room. Is the server running?");
    setBusy(false);
  }
}

async function joinRoom(name: string, rawCode: string) {
  if (busy) return;
  const code = rawCode.trim().toUpperCase();
  if (!CODE_RE.test(code)) {
    showError("Enter a 4-character room code.");
    return;
  }
  setBusy(true);
  try {
    const room = await client.join(ROOM_NAME, { name: playerName(name), code });
    enterGame(room);
  } catch (err) {
    console.error("Join failed:", err);
    showError(`Room ${code} not found — it may be full or already closed.`);
    setBusy(false);
  }
}

/** Hand the connected room to a freshly booted game and reveal the room bar. */
function enterGame(room: Room) {
  $<HTMLDivElement>("menu").hidden = true;

  const game = new Phaser.Game(gameConfig);
  game.registry.set("room", room);
  // Dev-only console handle (stripped from prod builds).
  if (import.meta.env.DEV) (window as unknown as { game: Phaser.Game }).game = game;

  whenCode(room, (code) => showRoomBar(code));
}

/** Run cb with the room's join code, now or once the first state arrives. */
function whenCode(room: Room, cb: (code: string) => void) {
  const state = room.state as { code?: string } | undefined;
  if (state?.code) cb(state.code);
  else room.onStateChange.once(() => cb((room.state as { code: string }).code));
}

function showRoomBar(code: string) {
  $<HTMLSpanElement>("roomcode").textContent = code;

  const url = `${location.origin}${location.pathname}?room=${code}`;
  history.replaceState(null, "", `?room=${code}`);

  const copyBtn = $<HTMLButtonElement>("copy");
  copyBtn.onclick = async () => {
    if (await copyText(url)) flash(copyBtn, "Copied!");
    // Last resort: show the link in a prompt so it can be copied manually.
    else window.prompt("Copy this link:", url);
  };

  $<HTMLDivElement>("roombar").hidden = false;
}

/**
 * Copy text across contexts. The async Clipboard API only works on secure
 * origins (https / localhost), so over plain-IP http (the LAN case) we fall back
 * to the legacy execCommand("copy") via a temporary textarea. Returns whether a
 * copy succeeded.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* insecure context or denied — fall through */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function flash(btn: HTMLButtonElement, msg: string) {
  const original = btn.textContent;
  btn.textContent = msg;
  window.setTimeout(() => (btn.textContent = original), 1600);
}

function setBusy(value: boolean) {
  busy = value;
  $<HTMLButtonElement>("create").disabled = value;
  $<HTMLButtonElement>("join").disabled = value;
}

function showError(msg: string) {
  const el = $<HTMLParagraphElement>("error");
  el.textContent = msg;
  el.hidden = false;
}
