const Hero = ({ eyebrow, title, subtitle }) => (
  <section className="hero">
    <span className="hero-eyebrow">{eyebrow}</span>
    <h1 dangerouslySetInnerHTML={{ __html: title }} />
    {subtitle && <p>{subtitle}</p>}
  </section>
);
window.Hero = Hero;
