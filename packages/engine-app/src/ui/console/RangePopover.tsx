import { Box, Button, Popover, Stack, TextField, Tooltip, Typography } from "@mui/material";
import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import type { ParamDesc } from "../engine-link";
import { useEngine } from "../hooks";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Stack direction="row" spacing={0.75} alignItems="center">
      <Typography variant="caption" color="text.secondary" sx={{ width: 40, flex: "0 0 auto" }}>
        {label}
      </Typography>
      {children}
    </Stack>
  );
}

type Props = {
  instance: string;
  path: string;
  p: ParamDesc;
  anchorEl: HTMLElement | null;
  onClose: () => void;
};

/** Round int bounds; leave floats to ~4 significant decimals for a tidy field. */
function fmt(n: number, isInt: boolean): string {
  if (isInt) return String(Math.round(n));
  return String(Math.round(n * 1e4) / 1e4);
}

/**
 * Grow/shrink a [min,max] span. Symmetric ranges (e.g. -1..1) expand both ways;
 * everything else anchors at min and stretches the top — the intuitive move for
 * the common 0..N slider.
 */
function widen([min, max]: [number, number]): [number, number] {
  const span = max - min;
  if (min < 0 && Math.abs(min + max) < 1e-9) return [min - span / 2, max + span / 2];
  return [min, max + span];
}
function narrow([min, max]: [number, number]): [number, number] {
  const span = max - min;
  if (min < 0 && Math.abs(min + max) < 1e-9) return [min + span / 4, max - span / 4];
  return [min, max - span / 2];
}

/**
 * Edit a float|int slider's bounds live (TouchDesigner-style). Three fidelities:
 * exact min/max fields, ⊟/⊞ quick halve/double, and a value field that widens
 * the range to swallow an out-of-bounds number. Reset snaps to the author range.
 */
export function RangePopover({ instance, path, p, anchorEl, onClose }: Props) {
  const link = useEngine();
  const open = anchorEl != null;
  const isInt = p.type === "int";
  const curMin = typeof p.min === "number" ? p.min : 0;
  const curMax = typeof p.max === "number" ? p.max : 1;
  const declared = p.defaultRange ?? [curMin, curMax];
  const overridden = p.defaultRange != null;

  const [minS, setMinS] = useState(fmt(curMin, isInt));
  const [maxS, setMaxS] = useState(fmt(curMax, isInt));
  const [valS, setValS] = useState(fmt(Number(p.value), isInt));
  const [err, setErr] = useState("");

  // Reseed from the live param each time the popover opens.
  useEffect(() => {
    if (!open) return;
    setErr("");
    setMinS(fmt(curMin, isInt));
    setMaxS(fmt(curMax, isInt));
    setValS(fmt(Number(p.value), isInt));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const applyRange = (min: number, max: number) => {
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      setErr("min and max must be numbers");
      return;
    }
    if (min >= max) {
      setErr("min must be below max");
      return;
    }
    setErr("");
    setMinS(fmt(min, isInt));
    setMaxS(fmt(max, isInt));
    void link
      .sendParamRange(instance, path, { min, max })
      .catch((e: Error) => setErr(String(e.message ?? e)));
  };

  // Commit a precise value; widen the range first if it falls outside the bounds.
  const applyValue = () => {
    const v = Number(valS);
    if (!Number.isFinite(v)) {
      setErr("value must be a number");
      return;
    }
    setErr("");
    const min = Math.min(curMin, v);
    const max = Math.max(curMax, v);
    const expand = min < curMin || max > curMax;
    const send = () => link.sendParam(instance, path, isInt ? Math.round(v) : v);
    if (expand) {
      void link
        .sendParamRange(instance, path, { min, max })
        .then(send)
        .catch((e: Error) => setErr(String(e.message ?? e)));
    } else {
      send();
    }
  };

  const reset = () => {
    setErr("");
    void link
      .sendParamRange(instance, path, { restoreDefault: true })
      .catch((e: Error) => setErr(String(e.message ?? e)));
  };

  const onKey = (commit: () => void) => (e: KeyboardEvent) => {
    if (e.key === "Enter") commit();
  };

  const numProps = isInt ? { step: 1 } : { step: "any" };

  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      transformOrigin={{ vertical: "top", horizontal: "right" }}
    >
      <Box
        className="rangepop"
        sx={{ p: 1.5, width: 248, display: "flex", flexDirection: "column", gap: 1 }}
      >
        <Typography variant="caption" color="text.secondary" noWrap>
          range · {path}
        </Typography>
        <Row label="min">
          <TextField
            type="number"
            size="small"
            value={minS}
            inputProps={{ ...numProps, "data-range-min": path }}
            onChange={(e) => setMinS(e.target.value)}
            onKeyDown={onKey(() => applyRange(Number(minS), Number(maxS)))}
            onBlur={() => applyRange(Number(minS), Number(maxS))}
            sx={{ width: 96 }}
          />
          <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }} noWrap>
            to
          </Typography>
          <TextField
            type="number"
            size="small"
            value={maxS}
            inputProps={{ ...numProps, "data-range-max": path }}
            onChange={(e) => setMaxS(e.target.value)}
            onKeyDown={onKey(() => applyRange(Number(minS), Number(maxS)))}
            onBlur={() => applyRange(Number(minS), Number(maxS))}
            sx={{ width: 96 }}
          />
        </Row>
        <Row label="value">
          <TextField
            type="number"
            size="small"
            value={valS}
            inputProps={{ ...numProps }}
            onChange={(e) => setValS(e.target.value)}
            onKeyDown={onKey(applyValue)}
            sx={{ width: 96 }}
          />
          <Tooltip title="set the value; widens the range if it falls outside" disableInteractive>
            <Button size="small" onClick={applyValue} sx={{ minWidth: 0, px: 1 }}>
              set
            </Button>
          </Tooltip>
        </Row>
        <Stack direction="row" spacing={0.5} alignItems="center">
          <Tooltip title="halve the range" disableInteractive>
            <Button
              size="small"
              onClick={() => applyRange(...narrow([curMin, curMax]))}
              sx={{ minWidth: 0, px: 1 }}
            >
              ⊟
            </Button>
          </Tooltip>
          <Tooltip title="double the range" disableInteractive>
            <Button
              size="small"
              onClick={() => applyRange(...widen([curMin, curMax]))}
              sx={{ minWidth: 0, px: 1 }}
            >
              ⊞
            </Button>
          </Tooltip>
          <Box sx={{ flex: 1 }} />
          <Tooltip
            title={`reset to default ${fmt(declared[0], isInt)}–${fmt(declared[1], isInt)}`}
            disableInteractive
          >
            <span>
              <Button
                size="small"
                color="warning"
                disabled={!overridden}
                onClick={reset}
                sx={{ minWidth: 0, px: 1 }}
              >
                reset
              </Button>
            </span>
          </Tooltip>
        </Stack>
        {err !== "" && (
          <Typography variant="caption" color="error">
            {err}
          </Typography>
        )}
      </Box>
    </Popover>
  );
}
