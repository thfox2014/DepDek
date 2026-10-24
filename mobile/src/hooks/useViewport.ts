import { useEffect } from "react";

/** Keyboard resize without scrollIntoView or a permanent animation loop. */
export function useViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () => {
      const height = viewport?.height || window.innerHeight;
      document.documentElement.style.setProperty(
        "--viewport-height",
        `${height}px`,
      );
      document.documentElement.dataset.keyboard = String(
        window.innerHeight - height > 140,
      );
    };
    update();
    viewport?.addEventListener("resize", update);
    window.addEventListener("resize", update);
    return () => {
      viewport?.removeEventListener("resize", update);
      window.removeEventListener("resize", update);
    };
  }, []);
}
