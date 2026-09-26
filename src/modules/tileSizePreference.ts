import { getPref, setPref } from "../utils/prefs";

const DEFAULT_SIZE = 180;
const MIN_PERCENT = 50;
const MAX_PERCENT = 200;

/** Keep the percentage entry in sync with Zotero's pixel-size preference. */
export function attachTileSizePreference(
  slider: HTMLInputElement,
  percentage: HTMLInputElement,
): () => void {
  const syncFromSlider = () => {
    percentage.value = String(
      Math.round((Number(slider.value) / DEFAULT_SIZE) * 100),
    );
  };

  const commitPercentage = (clamp: boolean) => {
    const entered = percentage.valueAsNumber;
    if (!Number.isFinite(entered)) {
      if (clamp) syncFromSlider();
      return;
    }
    if (!clamp && (entered < MIN_PERCENT || entered > MAX_PERCENT)) return;

    const percent = Math.max(
      MIN_PERCENT,
      Math.min(MAX_PERCENT, Math.round(entered)),
    );
    const pixels = Math.round((percent / 100) * DEFAULT_SIZE);
    percentage.value = String(percent);
    slider.value = String(pixels);
    if (getPref("tileSize") !== pixels) setPref("tileSize", pixels);
  };

  const onInput = () => commitPercentage(false);
  const onChange = () => commitPercentage(true);
  slider.addEventListener("input", syncFromSlider);
  slider.addEventListener("syncfrompreference", syncFromSlider);
  percentage.addEventListener("input", onInput);
  percentage.addEventListener("change", onChange);
  slider.value = String(getPref("tileSize"));
  syncFromSlider();

  return () => {
    slider.removeEventListener("input", syncFromSlider);
    slider.removeEventListener("syncfrompreference", syncFromSlider);
    percentage.removeEventListener("input", onInput);
    percentage.removeEventListener("change", onChange);
  };
}
