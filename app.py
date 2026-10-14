"""Vercel entry point for the training API."""

from fastapi import FastAPI

from backend.app import api_lifespan, configure_app

app = FastAPI(lifespan=api_lifespan)
configure_app(app)
