/**
 * M0 debug renderer: a plain 2D top-down view.
 *
 * There is deliberately no 3D here. M0 exists to prove prediction,
 * reconciliation and interpolation are correct, and a top-down view showing the
 * predicted position, the smoothed render position and the last server-confirmed
 * position all at once makes netcode bugs visible in a way a first-person
 * camera never would. Three.js arrives at M1.
 */

const TEAM_COLORS = ['#ff3d8b', '#8bff3d'];

export class TopDownRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{def: {brushes: Array}, mins: number[], maxs: number[]}} world
   */
  constructor(canvas, world) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.world = world;
    this.pixelsPerUnit = 0.32;
    this.showDebugMarkers = true;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    // Cap at 1 device pixel ratio: a HiDPI screen otherwise renders 4x the
    // pixels for no visible benefit, which is a large share of "why is it slow".
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = w;
    this.canvas.height = h;
  }

  /**
   * @param {object} view
   * @param {Float32Array} view.localPos       smoothed render position
   * @param {Float32Array} view.localRawPos    raw predicted position
   * @param {Float32Array|null} view.serverPos last position the server confirmed
   * @param {number} view.localYaw
   * @param {number} view.localTeam
   * @param {Array} view.remotes
   */
  draw(view) {
    const ctx = this.ctx;
    const { width: W, height: H } = this.canvas;
    const s = this.pixelsPerUnit;

    ctx.fillStyle = '#141021';
    ctx.fillRect(0, 0, W, H);

    // World -> screen, centred on the local player.
    const cx = view.localPos[0];
    const cy = view.localPos[1];
    const toX = (wx) => W / 2 + (wx - cx) * s;
    // Screen Y is inverted relative to world +Y.
    const toY = (wy) => H / 2 - (wy - cy) * s;

    // --- level geometry ---
    ctx.strokeStyle = '#332a52';
    ctx.fillStyle = '#221c3a';
    ctx.lineWidth = 1;
    for (const b of this.world.def.brushes) {
      const box = b.aabb || b.bounds;
      if (!box) continue;
      // Skip the floor and ceiling slabs; they cover everything and read as noise.
      if (b.mat === 'floor' || b.mat === 'ceiling') continue;
      const x0 = toX(box[0]);
      const y0 = toY(box[4]);
      const x1 = toX(box[3]);
      const y1 = toY(box[1]);
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    }

    // --- remote players (interpolated) ---
    for (const r of view.remotes) {
      this.drawPlayer(
        ctx, toX(r.pos[0]), toY(r.pos[1]), r.yaw,
        TEAM_COLORS[r.team] || '#888',
        r.extrapolated ? 0.45 : 1,
      );
    }

    // --- local player debug markers ---
    if (this.showDebugMarkers) {
      if (view.serverPos) {
        // Where the server last said we were: should trail slightly behind.
        ctx.strokeStyle = 'rgba(255,255,255,0.30)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(toX(view.serverPos[0]), toY(view.serverPos[1]), 15 * s, 0, Math.PI * 2);
        ctx.stroke();
      }
      // Raw prediction, before error smoothing. Visibly separates from the
      // drawn position for ~100ms after a correction, then converges.
      ctx.strokeStyle = 'rgba(255,220,80,0.55)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(toX(view.localRawPos[0]), toY(view.localRawPos[1]), 15 * s, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    this.drawPlayer(
      ctx, W / 2, H / 2, view.localYaw,
      TEAM_COLORS[view.localTeam] || '#fff', 1, true,
    );

    // --- scale bar ---
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.lineWidth = 1;
    const barUnits = 320; // one second of running
    ctx.beginPath();
    ctx.moveTo(16, H - 20);
    ctx.lineTo(16 + barUnits * s, H - 20);
    ctx.stroke();
    ctx.fillText('320u = 1s of running', 16, H - 26);
  }

  drawPlayer(ctx, x, y, yaw, color, alpha, isLocal = false) {
    const r = 15 * this.pixelsPerUnit;
    ctx.globalAlpha = alpha;

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(r, 4), 0, Math.PI * 2);
    ctx.fill();

    if (isLocal) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Facing indicator. World yaw 0 is +X, and screen Y is flipped.
    const len = Math.max(r, 4) * 2.2;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(yaw) * len, y - Math.sin(yaw) * len);
    ctx.stroke();

    ctx.globalAlpha = 1;
  }
}
