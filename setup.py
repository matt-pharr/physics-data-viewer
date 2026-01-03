from setuptools import find_packages, setup


setup(
    name="physics-data-viewer",
    version="0.1.0",
    description="Foundation for the physics data analysis platform",
    package_dir={"": "src"},
    packages=find_packages(where="src"),
    include_package_data=True,
    install_requires=["pyyaml>=6.0.1"],
    python_requires=">=3.8",
)
