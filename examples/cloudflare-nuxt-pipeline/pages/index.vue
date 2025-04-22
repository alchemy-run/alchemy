<template>
  <div>
    <h1>Nuxt 3 + Alchemy + Cloudflare Pipeline Demo</h1>
    <form @submit.prevent="sendToPipeline">
      <label for="dataInput">Data to send:</label>
      <input id="dataInput" v-model="dataToSend" type="text" required />
      <button type="submit" :disabled="loading">Send to Pipeline</button>
    </form>
    <p v-if="message">{{ message }}</p>
    <p v-if="error" style="color: red">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";

const dataToSend = ref("");
const loading = ref(false);
const message = ref("");
const error = ref("");

async function sendToPipeline() {
  loading.value = true;
  message.value = "";
  error.value = "";

  try {
    const response = await fetch("/api/pipeline", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ data: dataToSend.value }),
    });

    const result = (await response.json()) as {
      message?: string;
      statusMessage?: string;
    };

    if (!response.ok) {
      throw new Error(result.statusMessage || "Failed to send data");
    }

    message.value = result.message || "Data sent successfully!";
    dataToSend.value = ""; // Clear input after success
  } catch (err) {
    error.value =
      err instanceof Error ? err.message : "An unknown error occurred.";
    console.error("Error sending to pipeline:", err);
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: 300px;
  margin-top: 20px;
}
label {
  font-weight: bold;
}
input {
  padding: 8px;
  border: 1px solid #ccc;
  border-radius: 4px;
}
button {
  padding: 10px;
  background-color: #007bff;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}
button:disabled {
  background-color: #ccc;
  cursor: not-allowed;
}
</style>
