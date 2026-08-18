/**
 * Keyboard and mouse input.
 *
 * Produces raw analogue values only. Quantization to the wire format happens in
 * main.js immediately before both prediction and transmission, so the client
 * always predicts with exactly the numbers the server will receive.
 */

import { BTN_CROUCH, BTN_FIRE, BTN_JUMP } from '../../../shared/constants.js';
import { clamp } from '../../../shared/math.js';

const PITCH_LIMIT = Math.PI / 2 - 0.01;

export class Input {
  /** @param {HTMLElement} element */
  constructor(element) {
    this.element = element;
    this.keys = new Set();
    this.mouseButtons = 0;
    this.yaw = 0;
    this.pitch = 0;
    this.sensitivity = 0.0022; // radians per pixel
    this.locked = false;
    this.enabled = true;
  }

  attach() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      // Space scrolls the page and F-keys do worse; only swallow while playing.
      if (this.locked && (e.code === 'Space' || e.code === 'Tab')) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouseButtons = 0;
    });

    this.element.addEventListener('mousedown', (e) => {
      if (!this.locked) {
        this.element.requestPointerLock();
        return;
      }
      this.mouseButtons |= 1 << e.button;
    });
    window.addEventListener('mouseup', (e) => {
      this.mouseButtons &= ~(1 << e.button);
    });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.element;
      if (!this.locked) {
        this.keys.clear();
        this.mouseButtons = 0;
      }
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * this.sensitivity;
      this.pitch = clamp(
        this.pitch - e.movementY * this.sensitivity,
        -PITCH_LIMIT,
        PITCH_LIMIT,
      );
    });
  }

  /** Raw, unquantized. */
  sample() {
    if (!this.enabled || !this.locked) {
      return { forward: 0, right: 0, yaw: this.yaw, pitch: this.pitch, buttons: 0 };
    }

    let forward = 0;
    let right = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) forward += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) forward -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) right += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) right -= 1;

    let buttons = 0;
    if (this.keys.has('Space')) buttons |= BTN_JUMP;
    if (this.keys.has('ShiftLeft') || this.keys.has('ControlLeft')) buttons |= BTN_CROUCH;
    if (this.mouseButtons & 1) buttons |= BTN_FIRE;

    return { forward, right, yaw: this.yaw, pitch: this.pitch, buttons };
  }
}
