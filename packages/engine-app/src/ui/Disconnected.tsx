import { Box } from "@mui/material";
import { useEffect } from "react";

export function Disconnected({ connected, starting }: { connected: boolean; starting?: boolean }) {
  // validate-m4 reads document.body.classList on the staged page.
  useEffect(() => {
    document.body.classList.toggle("disconnected", !connected);
  }, [connected]);
  if (connected) return null;
  return (
    <Box
      id="disconnected"
      sx={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        p: 1.25,
        textAlign: "center",
        bgcolor: starting ? "warning.main" : "error.main",
        color: starting ? "#000" : "#fff",
        zIndex: 2000,
      }}
    >
      {starting ? (
        <>starting an embedded engine…</>
      ) : (
        <>engine not found — is the Output window (<code>/</code>) open?</>
      )}
    </Box>
  );
}
