"""Vercel entry point when backend/ is the project root."""

from fastapi import FastAPI

if __package__:
    from .app import api_lifespan, configure_app
else:
    from app import api_lifespan, configure_app

app = FastAPI(lifespan=api_lifespan)
configure_app(app)
