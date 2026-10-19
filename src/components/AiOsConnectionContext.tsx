import { createContext, useContext } from "react";
import type { AiOsConnectionMode } from "../api";
export const AiOsConnectionContext = createContext<AiOsConnectionMode>("online");
export const useAiOsConnectionMode = () => useContext(AiOsConnectionContext);
