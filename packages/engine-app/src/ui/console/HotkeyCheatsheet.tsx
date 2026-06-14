import { Backdrop, Box, Chip, Stack, Typography } from "@mui/material";
import { GROUP_ORDER, KEYBINDINGS } from "./keybindings";
import type { Binding, Group } from "./keymap";
import { mono } from "../theme";

/**
 * The `?` cheatsheet (keyboard-shortcuts Phase 2 / FR-5/FR-6).
 *
 * A single MUI overlay that renders the keymap registry GROUPED — one row per
 * binding, straight from {@link KEYBINDINGS}. Because it renders the registry, it
 * CANNOT drift: adding a binding adds a cheatsheet row for free (the drift guard
 * the unit test enforces). Columns lay the groups out so it fits ~1080p without
 * scrolling at the current binding count; internal scroll only when it grows big.
 *
 * Closes on `?`, `Escape` (both via the keymap), or a backdrop click.
 *
 * DOM contract for the reviewer/validator: `#cheatsheet`, `.hk-group`, `.hk-row`.
 */
export function HotkeyCheatsheet({ onClose }: { onClose: () => void }) {
  // Bucket bindings by group, preserving registry order within a group. Duplicate
  // labels (e.g. two Escape entries) collapse to one row by label so the sheet
  // stays clean — the cheatsheet documents intent, not every internal binding.
  const byGroup = new Map<Group, Binding[]>();
  const seen = new Set<string>();
  for (const b of KEYBINDINGS) {
    const key = `${b.group}:${b.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = byGroup.get(b.group) ?? [];
    list.push(b);
    byGroup.set(b.group, list);
  }
  const groups = GROUP_ORDER.filter((g) => byGroup.has(g));

  return (
    <Backdrop
      open
      onClick={onClose}
      sx={{ zIndex: (t) => t.zIndex.modal + 1, bgcolor: "rgba(0,0,0,0.78)", alignItems: "flex-start" }}
    >
      <Box
        id="cheatsheet"
        // Stop a click INSIDE the card from closing (backdrop click closes).
        onClick={(e) => e.stopPropagation()}
        sx={{
          mt: 6,
          mx: 3,
          maxWidth: 1100,
          maxHeight: "88vh",
          overflowY: "auto",
          bgcolor: "background.paper",
          border: 1,
          borderColor: "divider",
          borderRadius: 2,
          p: 3,
          boxShadow: 8,
        }}
      >
        <Stack direction="row" alignItems="baseline" spacing={1.5} sx={{ mb: 2 }}>
          <Typography variant="h6" sx={{ fontFamily: mono, letterSpacing: ".12em" }}>
            KEYBOARD SHORTCUTS
          </Typography>
          <Typography variant="caption" color="text.secondary">
            press ? or Esc to close · keys ignored while typing in a field
          </Typography>
        </Stack>
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            gap: 3,
            alignItems: "start",
          }}
        >
          {groups.map((group) => (
            <Box key={group} className="hk-group" data-group={group}>
              <Typography variant="overline" sx={{ color: "primary.main", fontWeight: 700, letterSpacing: ".14em" }}>
                {group}
              </Typography>
              <Stack spacing={0.75} sx={{ mt: 0.5 }}>
                {(byGroup.get(group) ?? []).map((b) => (
                  <Stack
                    key={b.id}
                    className="hk-row"
                    direction="row"
                    alignItems="center"
                    spacing={1}
                    justifyContent="space-between"
                  >
                    <Typography variant="body2" sx={{ color: "text.primary" }}>
                      {b.label}
                    </Typography>
                    <Chip
                      label={b.hint}
                      size="small"
                      sx={{
                        fontFamily: mono,
                        fontSize: 12,
                        height: 22,
                        bgcolor: "#0006",
                        border: 1,
                        borderColor: "divider",
                        "& .MuiChip-label": { px: 0.9 },
                      }}
                    />
                  </Stack>
                ))}
              </Stack>
            </Box>
          ))}
        </Box>
      </Box>
    </Backdrop>
  );
}
