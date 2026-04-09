# Stage 1: build
FROM rust:1.82-bookworm AS builder
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release

# Stage 2: minimal runtime
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/wheel-of-shame /usr/local/bin/
ENV PORT=8080
EXPOSE 8080
CMD ["wheel-of-shame"]
