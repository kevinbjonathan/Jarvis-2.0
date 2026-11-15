@echo off
rem ===================================================================
rem  Your private keys. This file is ignored by git and never uploaded.
rem ===================================================================
rem
rem  ELEVENLABS_API_KEY - enables the ElevenLabs voice and Scribe.
rem  Set JARVIS_VOICE_ID in .env to choose a voice; the bridge defaults to
rem  George. Without a key, JARVIS speaks with the built-in browser voice.
rem
rem  Get a key: https://elevenlabs.io -> your profile -> API keys.
rem  Paste it between the = and the closing quote, with no spaces, then save.

set "ELEVENLABS_API_KEY="
