import * as Layer from "effect/Layer";
import { SerialPort, SerialPortProvider } from "./SerialPort.ts";

export const resources = [SerialPort];
export const layers = () => Layer.mergeAll(SerialPortProvider());
