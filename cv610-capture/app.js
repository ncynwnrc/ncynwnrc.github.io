"use strict";

const SERVICE_UUID = 0xfff0;
const COMMAND_UUID = 0xfff1;
const RESPONSE_UUID = 0xfff2;
const WRITE_CHUNK_BYTES = 18;

const elements = {
  connectView: document.querySelector("#connectView"),
  controlView: document.querySelector("#controlView"),
  connectButton: document.querySelector("#connectButton"),
  disconnectButton: document.querySelector("#disconnectButton"),
  connectError: document.querySelector("#connectError"),
  connectionState: document.querySelector("#connectionState"),
  connectionText: document.querySelector("#connectionText"),
  serviceState: document.querySelector("#serviceState"),
  wifiState: document.querySelector("#wifiState"),
  ipAddress: document.querySelector("#ipAddress"),
  captureTotal: document.querySelector("#captureTotal"),
  captureSummary: document.querySelector("#captureSummary"),
  captureButton: document.querySelector("#captureButton"),
  captureButtonText: document.querySelector("#captureButtonText"),
  operationStatus: document.querySelector("#operationStatus"),
  refreshButton: document.querySelector("#refreshButton"),
  captureConfigForm: document.querySelector("#captureConfigForm"),
  captureCount: document.querySelector("#captureCount"),
  captureInterval: document.querySelector("#captureInterval"),
  captureEnabled: document.querySelector("#captureEnabled"),
  wifiForm: document.querySelector("#wifiForm"),
  wifiSsid: document.querySelector("#wifiSsid"),
  wifiPassword: document.querySelector("#wifiPassword"),
  wifiButton: document.querySelector("#wifiButton"),
  wifiDetail: document.querySelector("#wifiDetail"),
  passwordToggle: document.querySelector("#passwordToggle"),
  activityList: document.querySelector("#activityList"),
  lastFile: document.querySelector("#lastFile"),
  rtspLink: document.querySelector("#rtspLink"),
};

let bluetoothDevice = null;
let commandCharacteristic = null;
let responseCharacteristic = null;
let responseBuffer = "";
let requestId = 1;
let currentConfig = { capture_count: 3, interval_ms: 500, capture_enabled: true };
const decoder = new TextDecoder("utf-8");
const encoder = new TextEncoder();

function setConnection(connected, text = connected ? "已连接" : "未连接") {
  elements.connectionState.dataset.state = connected ? "online" : "offline";
  elements.connectionText.textContent = text;
  elements.connectView.hidden = connected;
  elements.controlView.hidden = !connected;
  elements.connectButton.disabled = false;
}

function setBusy(busy, message) {
  elements.captureButton.disabled = busy || !currentConfig.capture_enabled;
  elements.captureButtonText.textContent = busy ? "正在抓拍" : "开始抓拍";
  elements.connectionState.dataset.state = busy ? "busy" : "online";
  if (message) elements.operationStatus.textContent = message;
}

function appendActivity(message) {
  const item = document.createElement("li");
  const label = document.createElement("span");
  const time = document.createElement("time");
  label.textContent = message;
  time.textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  item.append(label, time);
  elements.activityList.prepend(item);
  while (elements.activityList.children.length > 8) {
    elements.activityList.lastElementChild.remove();
  }
}

function wifiStateLabel(state) {
  const labels = {
    connected: "已连接",
    disconnected: "未连接",
    configuring: "连接中",
    failed: "连接失败",
    unavailable: "不可用",
  };
  return labels[state] || state || "未知";
}

function applyConfig(config) {
  if (!config) return;
  currentConfig = { ...currentConfig, ...config };
  elements.captureCount.value = currentConfig.capture_count;
  elements.captureInterval.value = currentConfig.interval_ms;
  elements.captureEnabled.checked = currentConfig.capture_enabled;
  elements.captureSummary.textContent =
    `${currentConfig.capture_count} 张 / ${currentConfig.interval_ms} ms`;
  elements.captureButton.disabled = !currentConfig.capture_enabled;
}

function applyWifi(wifi) {
  if (!wifi) return;
  elements.wifiState.textContent = wifiStateLabel(wifi.state);
  elements.ipAddress.textContent = wifi.ip_address || "--";
  elements.wifiDetail.textContent = wifi.error
    ? `${wifiStateLabel(wifi.state)} · ${wifi.error}`
    : (wifi.ssid || wifiStateLabel(wifi.state));
  elements.wifiButton.disabled = Boolean(wifi.busy) || !wifi.available;
  elements.wifiButton.textContent = wifi.busy ? "正在连接" : "连接 Wi-Fi";
  if (wifi.ssid && document.activeElement !== elements.wifiSsid) {
    elements.wifiSsid.value = wifi.ssid;
  }
  if (wifi.ip_address) {
    const port = elements.rtspLink.dataset.port || "8554";
    elements.rtspLink.href = `rtsp://${wifi.ip_address}:${port}/live.h264`;
    elements.rtspLink.classList.remove("disabled");
  }
}

function handleResponse(message) {
  if (message.config) applyConfig(message.config);
  if (message.wifi) applyWifi(message.wifi);
  if (message.status) {
    elements.serviceState.textContent = message.status.service === "capturing" ? "抓拍中" : "就绪";
    elements.captureTotal.textContent = String(message.status.total_captures ?? 0);
    elements.lastFile.textContent = message.status.last_file || "暂无抓拍文件";
    elements.rtspLink.dataset.port = String(message.status.rtsp_port || 8554);
  }

  if (message.event === "capture.started") {
    setBusy(true, `任务 ${message.event_id} 已开始`);
    appendActivity(`开始连续抓拍 ${message.capture_count} 张`);
  } else if (message.event === "capture.completed") {
    setBusy(false, `${message.succeeded}/${message.requested} 张已保存`);
    if (message.last_file) elements.lastFile.textContent = message.last_file;
    appendActivity(`抓拍完成 ${message.succeeded}/${message.requested}`);
    void sendObject("status.get");
  } else if (message.event === "wifi.configuring") {
    appendActivity("Wi-Fi 配置已提交");
  } else if (message.event === "wifi.completed") {
    appendActivity(message.ok ? "Wi-Fi 已连接" : "Wi-Fi 连接失败");
    if (message.ok) elements.wifiPassword.value = "";
  } else if (message.ok === false) {
    appendActivity(`操作失败：${message.error || message.wifi?.error || "unknown"}`);
    setBusy(false, "操作未完成");
  }
}

function parseResponseText(text) {
  responseBuffer += text;
  let newline;
  while ((newline = responseBuffer.indexOf("\n")) >= 0) {
    const frame = responseBuffer.slice(0, newline).trim();
    responseBuffer = responseBuffer.slice(newline + 1);
    if (!frame) continue;
    try {
      handleResponse(JSON.parse(frame));
    } catch (error) {
      appendActivity("收到无法解析的设备响应");
    }
  }
}

function onNotification(event) {
  const value = event.target.value;
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  parseResponseText(decoder.decode(bytes, { stream: true }));
}

async function sendText(text) {
  if (!commandCharacteristic) throw new Error("设备未连接");
  const bytes = encoder.encode(text);
  for (let offset = 0; offset < bytes.length; offset += WRITE_CHUNK_BYTES) {
    const chunk = bytes.slice(offset, offset + WRITE_CHUNK_BYTES);
    if (commandCharacteristic.writeValueWithResponse) {
      await commandCharacteristic.writeValueWithResponse(chunk);
    } else {
      await commandCharacteristic.writeValue(chunk);
    }
    if (offset + WRITE_CHUNK_BYTES < bytes.length) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

async function sendObject(operation, values) {
  const message = { v: 1, id: requestId++, op: operation };
  if (values !== undefined) message.values = values;
  await sendText(JSON.stringify(message));
}

async function connectSelectedDevice(device) {
  bluetoothDevice = device;
  bluetoothDevice.addEventListener("gattserverdisconnected", onDisconnected);
  try {
    const server = await bluetoothDevice.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    commandCharacteristic = await service.getCharacteristic(COMMAND_UUID);
    responseCharacteristic = await service.getCharacteristic(RESPONSE_UUID);
    responseCharacteristic.addEventListener("characteristicvaluechanged", onNotification);
    await responseCharacteristic.startNotifications();
    responseBuffer = "";
    setConnection(true);
    appendActivity("蓝牙已连接");
    await sendObject("config.get");
    await sendObject("status.get");
    await sendObject("wifi.get");
  } catch (error) {
    setConnection(false);
    throw error;
  }
}

async function connectDevice() {
  elements.connectButton.disabled = true;
  elements.connectError.textContent = "";
  if (!navigator.bluetooth) {
    elements.connectError.textContent = "当前浏览器不支持 Web Bluetooth";
    elements.connectButton.disabled = false;
    return;
  }
  try {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: "CV610-Capture" }],
      optionalServices: [SERVICE_UUID],
    });
    await connectSelectedDevice(device);
  } catch (error) {
    elements.connectError.textContent = error.message || "连接失败";
    setConnection(false);
  }
}

async function reconnectKnownDevice() {
  if (!navigator.bluetooth?.getDevices) return;
  try {
    const devices = await navigator.bluetooth.getDevices();
    const known = devices.find((device) => device.name?.startsWith("CV610-Capture"));
    if (!known) return;
    elements.connectButton.disabled = true;
    elements.connectButton.textContent = "正在重新连接";
    await connectSelectedDevice(known);
  } catch (error) {
    elements.connectButton.disabled = false;
  } finally {
    elements.connectButton.textContent = "连接设备";
  }
}

function onDisconnected() {
  commandCharacteristic = null;
  responseCharacteristic = null;
  responseBuffer = "";
  setConnection(false);
}

elements.connectButton.addEventListener("click", () => void connectDevice());
elements.disconnectButton.addEventListener("click", () => {
  if (bluetoothDevice?.gatt?.connected) bluetoothDevice.gatt.disconnect();
});

elements.captureButton.addEventListener("click", async () => {
  try {
    setBusy(true, "正在提交抓拍任务");
    await sendObject("capture.trigger");
  } catch (error) {
    setBusy(false, error.message);
  }
});

elements.refreshButton.addEventListener("click", async () => {
  elements.refreshButton.disabled = true;
  try {
    await sendObject("status.get");
    await sendObject("wifi.get");
  } finally {
    elements.refreshButton.disabled = false;
  }
});

elements.captureConfigForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = {
    capture_count: Number(elements.captureCount.value),
    interval_ms: Number(elements.captureInterval.value),
    capture_enabled: elements.captureEnabled.checked,
  };
  try {
    await sendObject("config.set", values);
    appendActivity("抓拍参数已提交");
  } catch (error) {
    appendActivity(`参数提交失败：${error.message}`);
  }
});

elements.wifiForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.wifiButton.disabled = true;
  try {
    await sendObject("wifi.set", {
      ssid: elements.wifiSsid.value,
      password: elements.wifiPassword.value,
    });
  } catch (error) {
    appendActivity(`Wi-Fi 配置失败：${error.message}`);
    elements.wifiButton.disabled = false;
  }
});

elements.passwordToggle.addEventListener("click", () => {
  const showing = elements.wifiPassword.type === "text";
  elements.wifiPassword.type = showing ? "password" : "text";
  elements.passwordToggle.textContent = showing ? "显示" : "隐藏";
  elements.passwordToggle.setAttribute("aria-label", showing ? "显示密码" : "隐藏密码");
});

setConnection(false);
void reconnectKnownDevice();
