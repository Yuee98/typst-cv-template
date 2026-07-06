import { type RefObject, useEffect } from "react";

type OutsideRef = RefObject<HTMLElement | null>;

export function useClickOutside(
  ref: OutsideRef | OutsideRef[],
  onClose: () => void,
  active: boolean,
) {
  useEffect(() => {
    if (!active) {
      return;
    }

    function handleMouseDown(event: MouseEvent) {
      const refs = Array.isArray(ref) ? ref : [ref];
      const clickedInside = refs.some((item) => item.current?.contains(event.target as Node));

      if (!clickedInside) {
        onClose();
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [ref, onClose, active]);
}
