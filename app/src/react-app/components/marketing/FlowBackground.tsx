import { useEffect, useRef } from "react";

const LINE_COLOR = "99, 102, 241"; // indigo-500
const LINE_COUNT = 5;
const LINK_DISTANCE = 110;

/**
 * 营销首页的科技感流动背景：CSS 极光光晕 + canvas 流动曲线与粒子。
 * 不引入动画库；prefers-reduced-motion 下只画一帧静态画面，
 * 标签页隐藏时暂停 rAF。仅作装饰，aria-hidden + pointer-events-none。
 */
export default function FlowBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let raf = 0;
    let width = 0;
    let height = 0;

    type Particle = { x: number; y: number; vx: number; vy: number; r: number };
    let particles: Particle[] = [];

    const seedParticles = () => {
      const count = Math.min(Math.round((width * height) / 26000), 90);
      particles = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.25,
        vy: (Math.random() - 0.5) * 0.2,
        r: 0.8 + Math.random() * 1.2,
      }));
    };

    const resize = () => {
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seedParticles();
    };

    const draw = (t: number) => {
      ctx.clearRect(0, 0, width, height);
      const time = t * 0.001;

      // 流动曲线：几条正弦叠加的横线，相位随时间漂移
      for (let i = 0; i < LINE_COUNT; i++) {
        const baseY = height * (0.18 + (i / (LINE_COUNT - 1)) * 0.64);
        const amp = 18 + i * 6;
        const speed = 0.25 + i * 0.07;
        ctx.beginPath();
        for (let x = 0; x <= width; x += 8) {
          const y =
            baseY +
            Math.sin(x * 0.004 + time * speed + i * 1.7) * amp +
            Math.sin(x * 0.0016 - time * speed * 0.6 + i) * amp * 0.6;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = `rgba(${LINE_COLOR}, ${0.1 + i * 0.015})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // 缓慢漂移的粒子，近邻之间用细线相连
      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < -4) p.x = width + 4;
        else if (p.x > width + 4) p.x = -4;
        if (p.y < -4) p.y = height + 4;
        else if (p.y > height + 4) p.y = -4;
      }
      ctx.lineWidth = 0.6;
      for (let i = 0; i < particles.length; i++) {
        const a = particles[i];
        for (let j = i + 1; j < particles.length; j++) {
          const b = particles[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dist = Math.hypot(dx, dy);
          if (dist < LINK_DISTANCE) {
            ctx.strokeStyle = `rgba(${LINE_COLOR}, ${(1 - dist / LINK_DISTANCE) * 0.12})`;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
        ctx.fillStyle = `rgba(${LINE_COLOR}, 0.35)`;
        ctx.beginPath();
        ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const loop = (t: number) => {
      draw(t);
      raf = requestAnimationFrame(loop);
    };

    const start = () => {
      cancelAnimationFrame(raf);
      if (reduceMotion.matches) draw(0);
      else raf = requestAnimationFrame(loop);
    };
    const stop = () => cancelAnimationFrame(raf);
    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };

    resize();
    start();

    const ro = new ResizeObserver(() => {
      resize();
      if (reduceMotion.matches) draw(0);
    });
    ro.observe(canvas);
    reduceMotion.addEventListener("change", start);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stop();
      ro.disconnect();
      reduceMotion.removeEventListener("change", start);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="motion-safe:animate-flow-drift absolute -left-32 -top-32 h-[480px] w-[480px] rounded-full bg-[radial-gradient(circle_at_center,rgba(99,102,241,0.16),transparent_65%)] dark:bg-[radial-gradient(circle_at_center,rgba(99,102,241,0.24),transparent_65%)]" />
      <div className="motion-safe:animate-flow-drift-slow absolute -right-40 top-1/4 h-[560px] w-[560px] rounded-full bg-[radial-gradient(circle_at_center,rgba(14,165,233,0.14),transparent_65%)] dark:bg-[radial-gradient(circle_at_center,rgba(14,165,233,0.22),transparent_65%)]" />
      <div className="motion-safe:animate-flow-drift absolute -bottom-48 left-1/3 h-[520px] w-[520px] rounded-full bg-[radial-gradient(circle_at_center,rgba(139,92,246,0.12),transparent_65%)] dark:bg-[radial-gradient(circle_at_center,rgba(139,92,246,0.2),transparent_65%)]" />
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
    </div>
  );
}
