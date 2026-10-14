"""Vercel entry point for the training API."""

from backend.app import create_app

app = create_app()
