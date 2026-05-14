#!/usr/bin/env bun
// Simple CLI test for OpenCode integration
import { getOpenCodeClient } from "./src/bun/services/opencode-sdk";

async function testOpenCode() {
  console.log("🤖 Testing OpenCode CLI integration...");
  
  try {
    const client = await getOpenCodeClient();
    
    // Start server
    await client.startServer();
    console.log("✅ OpenCode server started");
    
    // Test query
    console.log("🔍 Testing query...");
    const response = await client.query({
      query: "What is 2+2?",
    });
    
    console.log("📝 Response:", response.response);
    console.log("✅ Test successful!");
    
    // Stop server
    await client.stopServer();
    console.log("🛑 OpenCode server stopped");
    
  } catch (error) {
    console.error("❌ Test failed:", error);
    process.exit(1);
  }
}

testOpenCode();