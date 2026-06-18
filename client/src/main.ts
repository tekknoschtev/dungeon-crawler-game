import Phaser from "phaser";
import { GameScene } from "./scenes/GameScene";
import { VIEW_W, VIEW_H } from "./config";

new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game",
  width: VIEW_W,
  height: VIEW_H,
  backgroundColor: "#0b0c10",
  pixelArt: true,
  scale: {
    // Fill the whole window; the camera zoom (GameScene) keeps tiles chunky and
    // shows more or less of the dungeon depending on the window size.
    mode: Phaser.Scale.RESIZE,
  },
  scene: [GameScene],
});
