/**
 * 液态玻璃动效系统与局部刷新动效增强（Liquid Motion with GSAP）
 *
 * 职责：
 * 1. 驱动页面元素错落有致的流体入场（Stagger Entrance）
 * 2. 环境光球漂移交互（Ambient Liquid Mesh Breathing）
 * 3. 局部状态变更平滑过渡（弹跳数字递增、卡片被局部移除/更新时的折叠过渡）
 * 4. 模态框与抽屉的弹性阻尼动画
 * 5. 严格遵守 prefers-reduced-motion 无障碍要求
 */

(function () {
  'use strict';

  const hasReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** 安全调用 GSAP，若未加载或系统开启减弱动画则静默降级为直达 */
  function runMotion(fn) {
    if (hasReducedMotion || typeof window.gsap === 'undefined') return;
    try {
      fn(window.gsap);
    } catch (e) {
      console.warn('[LiquidMotion] 动效调度异常:', e);
    }
  }

  const LiquidMotion = {
    /** 页面初次进入时各核心区块的流体浮现 */
    pageEnter(targets, options = {}) {
      runMotion((gsap) => {
        gsap.fromTo(
          targets,
          { opacity: 0, y: options.y || 24, scale: options.scale || 0.98 },
          {
            opacity: 1,
            y: 0,
            scale: 1,
            duration: options.duration || 0.65,
            stagger: options.stagger || 0.08,
            ease: 'power3.out',
            clearProps: 'transform',
          }
        );
      });
    },

    /** 点赞/投票数值微弹动效 */
    popBadge(el) {
      if (!el) return;
      runMotion((gsap) => {
        gsap.timeline()
          .to(el, { scale: 1.35, duration: 0.15, ease: 'back.out(2)' })
          .to(el, { scale: 1, duration: 0.3, ease: 'power2.out', clearProps: 'transform' });
      });
    },

    /** 按钮点击波纹与微形变反馈 */
    pressBounce(btn) {
      if (!btn) return;
      runMotion((gsap) => {
        gsap.timeline()
          .to(btn, { scale: 0.94, duration: 0.1, ease: 'power2.in' })
          .to(btn, { scale: 1, duration: 0.25, ease: 'elastic.out(1, 0.4)', clearProps: 'transform' });
      });
    },

    /** 抽屉/面板平滑滑入 */
    slideDown(el, onComplete) {
      if (!el) return;
      if (hasReducedMotion || typeof window.gsap === 'undefined') {
        el.style.display = 'block';
        if (onComplete) onComplete();
        return;
      }
      runMotion((gsap) => {
        el.style.display = 'block';
        gsap.fromTo(
          el,
          { opacity: 0, y: -16, height: 0 },
          {
            opacity: 1,
            y: 0,
            height: 'auto',
            duration: 0.4,
            ease: 'power3.out',
            onComplete,
          }
        );
      });
    },

    /** 局部刷新：单张卡片或行被删除时的平滑折叠淡出（避免突兀重排） */
    fadeCollapse(el, onDone) {
      if (!el) {
        if (onDone) onDone();
        return;
      }
      if (hasReducedMotion || typeof window.gsap === 'undefined') {
        if (el.parentNode) el.parentNode.removeChild(el);
        if (onDone) onDone();
        return;
      }
      runMotion((gsap) => {
        gsap.to(el, {
          opacity: 0,
          scale: 0.92,
          y: -10,
          duration: 0.28,
          ease: 'power2.in',
          onComplete: () => {
            gsap.to(el, {
              height: 0,
              paddingTop: 0,
              paddingBottom: 0,
              marginTop: 0,
              marginBottom: 0,
              borderWidth: 0,
              duration: 0.22,
              ease: 'power2.inOut',
              onComplete: () => {
                if (el.parentNode) el.parentNode.removeChild(el);
                if (onDone) onDone();
              },
            });
          },
        });
      });
    },

    /** 局部刷新：新加入节点的流光高亮与插入动效 */
    fadeInItem(el) {
      if (!el) return;
      runMotion((gsap) => {
        gsap.fromTo(
          el,
          { opacity: 0, y: 16, scale: 0.96 },
          {
            opacity: 1,
            y: 0,
            scale: 1,
            duration: 0.45,
            ease: 'back.out(1.4)',
            clearProps: 'transform',
          }
        );
      });
    },

    /** 对话框/悬浮层液态弹性弹出 */
    popModal(boxEl) {
      if (!boxEl) return;
      runMotion((gsap) => {
        gsap.fromTo(
          boxEl,
          { opacity: 0, scale: 0.88, y: 20 },
          { opacity: 1, scale: 1, y: 0, duration: 0.4, ease: 'back.out(1.5)', clearProps: 'transform' }
        );
      });
    },
  };

  window.LiquidMotion = LiquidMotion;

  // DOMContentLoaded 自动绑定首批动画与流体光晕微妙漂移
  document.addEventListener('DOMContentLoaded', () => {
    // 监听所有带 .btn-liquid 的按钮，注入微交互
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('button, .btn, .btn-liquid, .tab-btn');
      if (btn) LiquidMotion.pressBounce(btn);
    });

    // 背景流体光晕轻微动态漂移
    runMotion((gsap) => {
      const orb1 = document.querySelector('.liquid-orb-1');
      const orb2 = document.querySelector('.liquid-orb-2');
      const orb3 = document.querySelector('.liquid-orb-3');
      if (orb1) {
        gsap.to(orb1, {
          x: 'random(-40, 40)',
          y: 'random(-30, 30)',
          duration: 12,
          repeat: -1,
          yoyo: true,
          ease: 'sine.inOut',
        });
      }
      if (orb2) {
        gsap.to(orb2, {
          x: 'random(-50, 30)',
          y: 'random(-40, 40)',
          duration: 16,
          repeat: -1,
          yoyo: true,
          ease: 'sine.inOut',
        });
      }
      if (orb3) {
        gsap.to(orb3, {
          x: 'random(-30, 50)',
          y: 'random(-25, 35)',
          duration: 14,
          repeat: -1,
          yoyo: true,
          ease: 'sine.inOut',
        });
      }
    });
  });
})();
