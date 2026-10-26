import { useEffect } from "react";
import { followPhoneOutput } from "./phoneEndpoint";

export function usePhoneOutput(paired: boolean) {
  useEffect(() => {
    if (paired) return followPhoneOutput();
  }, [paired]);
}
