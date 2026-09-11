FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY coastline_twin ./coastline_twin
COPY docs ./docs
ENV MPLBACKEND=Agg COASTLINE_HOST=0.0.0.0 COASTLINE_PORT=8790 COASTLINE_RESULTS=/app/results
EXPOSE 8790
CMD ["python", "-m", "coastline_twin.web"]
